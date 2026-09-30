import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError, isAppError } from "@/shared/api/error";
import type { ModelUsageTag } from "@/shared/api/schemas";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Textarea } from "@/shared/components/ui/Textarea";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useModelTagOperation, type ModelTagAccess } from "./model-tag-access";
import type { ModelTagData } from "./model-tag-data";
import {
  assertTagBaseline,
  displayTagModel,
  modelTagSchema,
  sameTag,
  tagBody,
  tagFields,
  tagIdentityReason,
  tagListReason,
  tagValues,
  trimTagModel,
  type ModelTagValues,
} from "./model-tag-state";
import "./model-tag.css";

interface Review {
  body: ModelTagValues;
  before?: ModelUsageTag;
  raw: string;
}
interface Props {
  original?: ModelUsageTag;
  access: ModelTagAccess;
  data: ModelTagData;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}
export function ModelTagEditor({ original, access, data, onClose, returnFocusRef }: Props) {
  const [baseline, setBaseline] = useState(() => (original ? { ...original } : undefined));
  const form = useZodForm<ModelTagValues, ModelTagValues>(modelTagSchema, tagValues(original));
  const [review, setReview] = useState<Review>();
  const [confirmed, setConfirmed] = useState(false);
  const approval = useRef<{ review?: Review; confirmed: boolean }>({ confirmed: false });
  const updateReview = useCallback((next?: Review) => {
    approval.current = { review: next, confirmed: false };
    setReview(next);
    setConfirmed(false);
  }, []);
  const [error, setError] = useState<{ message: string; requestId?: string }>();
  const operation = useModelTagOperation(access);
  const heading = useRef<HTMLHeadingElement>(null);
  const identityReason =
    original && trimTagModel(original.model) !== original.model ? tagIdentityReason : undefined;
  const current = data.query.data?.tags.find((row) => row.model === (original?.model ?? review?.body.model));
  const changed = original ? !sameTag(current, baseline) : review && !sameTag(current, review.before);
  const reason =
    access.write.reason ??
    identityReason ??
    (!data.confirmed ? tagListReason : undefined) ??
    (changed ? "대상 태그가 변경되거나 삭제되었습니다. 최신 기준을 다시 선택하세요." : undefined);
  const fail = (cause: unknown) => {
    if (isAppError(cause) && cause.kind === "aborted") return;
    setError({
      message: safeAppErrorMessage(cause, "태그 변경을 검토하지 못했습니다."),
      requestId: isAppError(cause) ? cause.requestId : undefined,
    });
  };
  useEffect(() => {
    const subscription = form.watch(() => {
      updateReview();
    });
    return () => subscription.unsubscribe();
  }, [form, updateReview]);
  useEffect(() => {
    if (review) heading.current?.focus();
  }, [review]);
  const prepare = async () => {
    setError(undefined);
    try {
      await operation.run(
        async (assert) => {
          let values: ModelTagValues | undefined;
          await form.handleSubmit((output) => {
            values = output;
          })();
          assert();
          if (!values) return undefined;
          const body = tagBody(values, original);
          const rows = data.assertConfirmed();
          if (original) assertTagBaseline(rows, original.model, baseline);
          const before = rows.find((row) => row.model === body.model);
          return {
            body: { ...body },
            before: before ? { ...before } : undefined,
            raw: JSON.stringify(form.getValues()),
          };
        },
        (next) => {
          access.write.assertCurrent();
          data.assertConfirmed();
          updateReview(next);
        },
      );
    } catch (cause) {
      fail(cause);
    }
  };
  const rebase = () => {
    try {
      access.write.assertCurrent();
      const rows = data.assertConfirmed();
      const row = original ? rows.find((candidate) => candidate.model === original.model) : undefined;
      if (original && !row)
        throw new AppError("수정 대상이 삭제되었습니다. 초안을 복사한 뒤 닫고 새 태그로 추가하세요.", {
          kind: "contract",
        });
      setBaseline(row ? { ...row } : undefined);
      updateReview();
      setError(undefined);
    } catch (cause) {
      fail(cause);
    }
  };
  return (
    <FormDialog
      open
      form={form}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      returnFocusRef={returnFocusRef}
      title="모델 용도 태그"
      description="같은 모델 ID로 저장하면 기존 태그 전체를 덮어씁니다. 모델 이름 변경이 아니며 다른 관리자의 동시 변경을 막지 않습니다."
      submitLabel="검토한 태그 저장"
      scrollHint="초안은 자동 저장되지 않습니다. 내용이 길면 이 안내에 초점을 둔 뒤 위·아래 방향키로 살펴보세요."
      submitDisabled={operation.pending || !!reason || !review || !confirmed}
      onSubmit={async (values) => {
        await operation.run(
          async (assert, signal) => {
            const body = tagBody(values, original);
            if (
              !review ||
              !confirmed ||
              approval.current.review !== review ||
              !approval.current.confirmed ||
              review.raw !== JSON.stringify(form.getValues()) ||
              JSON.stringify(body) !== JSON.stringify(review.body)
            )
              throw new AppError("변경 내용을 다시 검토하고 확인하세요.", { kind: "contract" });
            assertTagBaseline(data.assertConfirmed(), body.model, review.before);
            assert();
            return apiClient.request(endpoints.domains.gateway.models.tags.save, {
              body,
              signal,
              routeId: "gateway.chat",
            });
          },
          () => {
            toast.success("모델 용도 태그를 저장했습니다.");
            data.afterCommit();
          },
        );
      }}
    >
      <div className="model-tag-draft form-grid">
        <div className="toolbar-start" role="group" aria-label="태그 검토 도구">
          <Button disabled={operation.pending || !!reason} onClick={() => void prepare()}>
            변경 내용 검토
          </Button>
          <Button
            disabled={operation.pending || data.query.isFetching || !access.readAllowed}
            onClick={() => void data.refresh().catch(fail)}
          >
            목록 다시 조회
          </Button>
          <Button
            disabled={operation.pending || !data.confirmed || !access.write.allowed || !!identityReason}
            onClick={rebase}
          >
            최신 기준 다시 선택
          </Button>
        </div>
        {reason ? (
          <InlineNotice tone="warning" title="태그 저장 잠김">
            {reason} 초안은 유지됩니다.
          </InlineNotice>
        ) : null}
        {error ? (
          <InlineNotice tone="danger" title="태그 검토 실패">
            {error.message}
            {error.requestId ? <p>요청 ID: {error.requestId}</p> : null}
          </InlineNotice>
        ) : null}
        {data.query.isError ? (
          <InlineNotice tone="warning" title="태그 목록 조회 실패">
            {safeAppErrorMessage(data.query.error, "목록을 다시 조회하세요.")}
            {isAppError(data.query.error) && data.query.error.requestId ? (
              <p>요청 ID: {data.query.error.requestId}</p>
            ) : null}
          </InlineNotice>
        ) : null}
        <fieldset className="form-grid form-dialog-fields" disabled={operation.pending || !!reason}>
          {tagFields.map(([key, label]) => (
            <FormField
              key={key}
              label={label}
              required={key === "model"}
              error={form.formState.errors[key]?.message}
              description={
                key === "model"
                  ? original
                    ? "수정 대상 ID는 처음 연 원문으로 고정됩니다."
                    : "같은 ID가 있으면 기존 값을 덮어씁니다. 앞뒤 서버 공백은 제거됩니다."
                  : undefined
              }
            >
              {(control) =>
                key === "risk_note" ? (
                  <Textarea {...control} rows={3} {...form.register(key)} />
                ) : (
                  <Input {...control} {...form.register(key)} readOnly={key === "model" && !!original} />
                )
              }
            </FormField>
          ))}
        </fieldset>
        {review ? (
          <section className="form-grid">
            <h3 ref={heading} tabIndex={-1}>
              태그 변경 비교
            </h3>
            <p>
              모델 ID의 공백·FEFF는 문자 코드로, 역슬래시는 두 번 표시합니다. 기준 수정 시각:{" "}
              {review.before?.updated_at || "새 태그"}
            </p>
            <InlineNotice tone={review.before ? "warning" : "info"}>
              {review.before
                ? "기존 모델의 태그 전체를 덮어씁니다. 빈 값은 기존 내용을 지웁니다."
                : "이 ID의 새 태그를 추가합니다."}
            </InlineNotice>
            <div className="model-tag-comparison" role="region" aria-label="태그 변경 비교 표 영역">
              <table className="data-table">
                <caption className="sr-only">태그 변경 전후 비교</caption>
                <thead>
                  <tr>
                    <th>항목</th>
                    <th>검토 기준</th>
                    <th>저장할 값</th>
                  </tr>
                </thead>
                <tbody>
                  {tagFields.map(([key, label]) => (
                    <tr key={key}>
                      <th scope="row">{label}</th>
                      <td>
                        {(key === "model"
                          ? displayTagModel(review.before?.model ?? "")
                          : review.before?.[key]) || "없음"}
                      </td>
                      <td>
                        {(key === "model" ? displayTagModel(review.body.model) : review.body[key]) || "없음"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Checkbox
              label="대상과 변경 내용을 확인했습니다."
              checked={confirmed}
              disabled={operation.pending || !!reason}
              onChange={(event) => {
                approval.current = { ...approval.current, confirmed: event.target.checked };
                setConfirmed(event.target.checked);
              }}
            />
          </section>
        ) : null}
      </div>
    </FormDialog>
  );
}
