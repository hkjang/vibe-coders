import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { z } from "zod";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError, isAppError } from "@/shared/api/error";
import type { ProfileDeleteReviewInput, ReviewedProfile } from "@/shared/api/domains/text2sql-profile-review";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Textarea } from "@/shared/components/ui/Textarea";
import { useDraftGuard } from "@/shared/unsaved/use-draft-guard";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useText2SqlMutation } from "../overview/use-text2sql-mutation";
import { text2sqlInvalidations, text2sqlRouteId } from "../overview/use-text2sql-queries";
import { ProfileSnapshotGate } from "./ProfileSnapshotGate";
import { ProfileDeleteImpact } from "./ProfileDeleteImpact";

interface Props {
  model: string;
  canWrite: boolean;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}
type Fields = { confirmation: string; reason: string };
export function ProfileDeleteDialog(props: Props): React.JSX.Element {
  return (
    <ProfileSnapshotGate
      model={props.model}
      title="런타임 프로필 삭제"
      onClose={props.onClose}
      returnFocusRef={props.returnFocusRef}
    >
      {(snapshot, readError) =>
        snapshot.profile ? <DeleteEditor {...props} initial={snapshot.profile} readError={readError} /> : null
      }
    </ProfileSnapshotGate>
  );
}
function DeleteEditor({
  initial,
  readError,
  ...props
}: Props & { initial: ReviewedProfile; readError: Error | null }): React.JSX.Element {
  const [current, setCurrent] = useState(initial);
  const [previous, setPrevious] = useState<ReviewedProfile>();
  const [needsReview, setNeedsReview] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<{ message: string; requestId?: string }>();
  const schema = z.object({
    confirmation: z
      .string()
      .refine((value) => value === props.model, "삭제할 가상 모델 이름을 정확히 입력하세요."),
    reason: z
      .string()
      .trim()
      .min(1, "삭제 사유를 입력하세요.")
      .refine((value) => [...value].length <= 500, "500자 이내로 입력하세요."),
  });
  const form = useZodForm<Fields, Fields>(schema, { confirmation: "", reason: "" }, { mode: "onTouched" });
  const cancel = useRef<HTMLButtonElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const formId = useId();
  const guard = useDraftGuard({ dirty: form.formState.isDirty, onDiscard: props.onClose });
  const read = useText2SqlMutation({
    readOnly: true,
    mutate: () =>
      apiClient.request(endpoints.domains.text2sql.profiles.review, {
        query: { view: "review", virtual_model: props.model },
        routeId: text2sqlRouteId,
      }),
  });
  const remove = useText2SqlMutation({
    authorized: props.canWrite,
    mutate: async (body: ProfileDeleteReviewInput) => {
      const receipt = await apiClient.request(endpoints.domains.text2sql.profiles.deleteReviewed, {
        body,
        routeId: text2sqlRouteId,
      });
      if (
        receipt.virtual_model !== body.virtual_model ||
        receipt.reviewed_revision !== body.expected_revision
      )
        throw new AppError("삭제 결과의 대상과 검토 기준을 확인하지 못했습니다.", { kind: "contract" });
      return receipt;
    },
    invalidates: text2sqlInvalidations.overview,
    successMessage: "프로필을 삭제하고 사유를 감사 이력에 기록했습니다.",
  });
  useEffect(() => {
    if ((!props.canWrite || missing) && !guard.pending) cancel.current?.focus();
  }, [props.canWrite, missing, guard.pending]);
  const fail = (cause: unknown) => {
    if (isAppError(cause) && (cause.status === 401 || cause.status === 403)) {
      props.onClose();
      return;
    }
    setNeedsReview(true);
    setError({
      message:
        isAppError(cause) && cause.code === "text2sql_profile_conflict"
          ? "프로필이 변경되었거나 삭제되었습니다. 사유를 유지한 채 최신 상태를 다시 검토하세요."
          : safeAppErrorMessage(
              cause,
              "삭제 결과를 확인하지 못했습니다. 재실행 전에 최신 상태를 확인하세요.",
            ),
      requestId: isAppError(cause) ? cause.requestId : undefined,
    });
  };
  const refresh = () => {
    if (!props.canWrite || guard.pending || missing) return;
    void guard.run(
      async () => {
        const snapshot = await read.mutateAsync();
        if (snapshot.profile && snapshot.profile.virtual_model !== props.model)
          throw new AppError("조회 대상이 다릅니다.", { kind: "contract" });
        return snapshot;
      },
      fail,
      (snapshot) => {
        setError(undefined);
        form.setValue("confirmation", "");
        if (!snapshot.profile) {
          setMissing(true);
          setNeedsReview(true);
          cancel.current?.focus();
          return;
        }
        setPrevious(current);
        setCurrent(snapshot.profile);
        setNeedsReview(false);
        reviewHeading.current?.focus();
      },
    );
  };
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!props.canWrite || guard.pending || needsReview || missing) return;
    void form.handleSubmit((values) => {
      const body: ProfileDeleteReviewInput = {
        ...values,
        virtual_model: props.model,
        expected_revision: current.revision,
      };
      setError(undefined);
      void guard.run(() => remove.mutateAsync(body), fail);
    })();
  };
  return (
    <Dialog
      open
      scrollBody
      wide={Boolean(previous)}
      title="런타임 프로필 삭제"
      description="현재 설정과 삭제 영향을 확인한 뒤 이름과 사유를 입력하세요."
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        if (props.canWrite) reviewHeading.current?.focus();
        else cancel.current?.focus();
      }}
      returnFocusRef={props.returnFocusRef}
      onOpenChange={(open) => {
        if (!open) guard.requestClose();
      }}
      footer={
        <>
          <Button ref={cancel} disabled={guard.pending} onClick={() => guard.requestClose()}>
            취소
          </Button>
          {needsReview && !missing ? (
            <Button disabled={guard.pending || !props.canWrite} onClick={refresh}>
              최신 상태로 다시 검토
            </Button>
          ) : null}
          <Button
            type="submit"
            form={formId}
            variant="danger"
            disabled={!props.canWrite || guard.pending || needsReview || missing}
          >
            {guard.pending ? "확인 중" : "검토한 프로필 삭제"}
          </Button>
        </>
      }
    >
      <div className="page-stack">
        <h3 ref={reviewHeading} tabIndex={-1}>
          삭제 영향과 현재 설정
        </h3>
        {!props.canWrite ? (
          <InlineNotice tone="warning" title="현재 삭제 권한이 없습니다">
            입력은 유지되며 삭제할 수 없습니다.
          </InlineNotice>
        ) : null}
        {readError ? (
          <InlineNotice tone="warning" title="최신 프로필 조회 실패">
            기존 검토 기준과 입력을 유지합니다. 삭제 직전에 서버에서 변경 여부를 다시 확인합니다.
            {isAppError(readError) && readError.requestId ? ` (요청 ID: ${readError.requestId})` : ""}
          </InlineNotice>
        ) : null}
        {error ? (
          <InlineNotice tone="danger" title="삭제 상태 확인 필요">
            {error.message}
            {error.requestId ? ` (요청 ID: ${error.requestId})` : ""}
          </InlineNotice>
        ) : null}
        {missing ? (
          <InlineNotice tone="info" title="프로필이 더 이상 존재하지 않습니다">
            삭제 요청을 다시 보내지 않습니다. 창을 닫고 최신 목록을 확인하세요.
          </InlineNotice>
        ) : (
          <ProfileDeleteImpact current={current} previous={previous} />
        )}
        {previous && !missing ? (
          <InlineNotice tone="info" title="검토 기준을 갱신했습니다">
            변경된 설정을 확인하고 대상 이름을 다시 입력하세요. 삭제 사유는 유지했습니다.
          </InlineNotice>
        ) : null}
        <form id={formId} onSubmit={submit}>
          <fieldset className="t2s-profile-fields" disabled={!props.canWrite || guard.pending || missing}>
            <FormField
              label="삭제할 가상 모델 이름"
              required
              description={`확인할 이름: ${props.model}`}
              error={form.formState.errors.confirmation?.message}
            >
              {(control) => (
                <Input
                  {...control}
                  {...form.register("confirmation")}
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
            </FormField>
            <FormField
              label="삭제 사유"
              required
              description="감사 이력에 기록할 사유를 500자 이내로 입력하세요. 비밀번호나 비밀키는 입력하지 마세요."
              error={form.formState.errors.reason?.message}
            >
              {(control) => <Textarea {...control} {...form.register("reason")} rows={3} />}
            </FormField>
          </fieldset>
        </form>
      </div>
    </Dialog>
  );
}
