import { useEffect, useId, useRef, useState, type RefObject } from "react";

import {
  contractBody,
  contractFields,
  contractSchema,
  contractValues,
  modelIdentityReason,
  modelPrecisionReason,
  safeModelTarget,
  type ContractInput,
  type ContractOutput,
} from "./model-governance-form";
import { ModelDraftBoundary } from "./ModelGovernanceState";
import { useModelAccess } from "./use-model-access";
import { useModelListPrerequisite } from "./use-model-governance";
import { ModelQueryFailure } from "./ModelGovernanceState";
import type { ModelContract } from "@/shared/api/domains/gateway.schemas";
import type { ModelContractWriteBody } from "@/shared/api/domains/gateway";
import { AppError, isAppError } from "@/shared/api/error";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useDraftGuard } from "@/shared/unsaved/use-draft-guard";
import { featureReadonlyReason } from "@/shared/feature-access/policy";
import "./model-governance.css";

interface Props {
  row?: ModelContract;
  onClose: () => void;
  save: (body: ModelContractWriteBody) => Promise<unknown>;
  returnFocusRef: RefObject<HTMLElement | null>;
  queryError?: unknown;
  refresh: () => void;
  refreshing: boolean;
}
export function ModelContractDialog(props: Props) {
  return (
    <ModelDraftBoundary>
      <ContractEditor {...props} />
    </ModelDraftBoundary>
  );
}
function ContractEditor({
  row: initial,
  onClose,
  save,
  returnFocusRef,
  queryError,
  refresh,
  refreshing,
}: Props) {
  const [row] = useState(() => (initial ? { ...initial } : undefined));
  const { write } = useModelAccess();
  const list = useModelListPrerequisite("contracts");
  const form = useZodForm<ContractInput, ContractOutput>(contractSchema, contractValues(row));
  const [review, setReview] = useState<ModelContractWriteBody>();
  const [error, setError] = useState<{ message: string; requestId?: string }>();
  const formId = useId();
  const lockId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const guard = useDraftGuard({ dirty: form.formState.isDirty, onDiscard: onClose });
  const identityOK = row === undefined || safeModelTarget(row.id, "contract");
  const precisionOK = row === undefined || Number.isSafeInteger(row.max_latency_ms);
  const reason =
    write.reason ??
    (identityOK ? undefined : modelIdentityReason) ??
    (precisionOK ? undefined : modelPrecisionReason) ??
    list.reason;
  const lockSummary = !reason
    ? undefined
    : write.reason
      ? write.reason === featureReadonlyReason
        ? "읽기 전용 · 저장 잠김"
        : "접근 권한 확인 필요 · 저장 잠김"
      : !identityOK || !precisionOK
        ? "계약 확인 필요 · 저장 잠김"
        : "목록 확인 필요 · 저장 잠김";
  const { setFocus } = form;
  useEffect(() => {
    if (review) heading.current?.focus();
    else setFocus("name");
  }, [review, setFocus]);
  const assertCurrent = () => {
    write.assertCurrent();
    list.assertCurrent();
    if (!identityOK) throw new AppError(modelIdentityReason, { kind: "contract" });
    if (!precisionOK) throw new AppError(modelPrecisionReason, { kind: "contract" });
  };
  const fail = (cause: unknown) =>
    setError({
      message: safeAppErrorMessage(cause, "모델 계약을 저장하지 못했습니다."),
      requestId: isAppError(cause) ? cause.requestId : undefined,
    });
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      assertCurrent();
    } catch (cause) {
      fail(cause);
      return;
    }
    setError(undefined);
    if (review) {
      void guard.run(() => {
        assertCurrent();
        return save(review);
      }, fail);
      return;
    }
    void guard.run(
      async () => {
        let body: ModelContractWriteBody | undefined;
        await form.handleSubmit((values) => {
          body = contractBody(values, row?.id);
        })();
        assertCurrent();
        if (body && !row) await save(body);
        return body;
      },
      fail,
      (body) => {
        if (!body) return;
        // Preparing a review is not a committed write. Recheck the initiating
        // access after asynchronous validation; readonly must retain the inputs.
        if (row) {
          assertCurrent();
          setReview(Object.freeze(body));
        } else onClose();
      },
    );
  };
  return (
    <Dialog
      open
      title={row ? "모델 계약 수정" : "모델 계약 추가"}
      description={
        row
          ? "열 때의 계약과 변경 내용을 검토합니다. 다른 관리자의 동시 변경을 막거나 병합하지 않습니다."
          : "0을 넣거나 비우면 해당 기준은 검사하지 않습니다."
      }
      onOpenChange={(open) => {
        if (!open) guard.requestClose();
      }}
      returnFocusRef={returnFocusRef}
      footer={
        <>
          {lockSummary ? (
            <p id={lockId} role="status" className="model-contract-lock">
              {lockSummary}
            </p>
          ) : null}
          <Button variant="secondary" disabled={guard.pending} onClick={() => guard.requestClose()}>
            취소
          </Button>
          {review ? (
            <Button
              variant="secondary"
              disabled={guard.pending || reason !== undefined}
              onClick={() => {
                setReview(undefined);
                setError(undefined);
              }}
            >
              다시 편집
            </Button>
          ) : null}
          <Button
            type="submit"
            form={formId}
            variant="primary"
            aria-describedby={lockSummary ? lockId : undefined}
            disabled={guard.pending || reason !== undefined}
          >
            {guard.pending ? "저장 중" : review ? "검토한 계약 저장" : row ? "변경 내용 검토" : "저장"}
          </Button>
        </>
      }
    >
      <form id={formId} className="form-grid model-contract-form" noValidate onSubmit={submit}>
        {reason ? <InlineNotice tone="warning">{reason}</InlineNotice> : null}
        {queryError ? (
          <ModelQueryFailure
            title="모델 계약 목록을 확인하지 못했습니다."
            error={queryError}
            retry={refresh}
            disabled={guard.pending || refreshing}
          />
        ) : (
          <Button size="small" variant="secondary" disabled={guard.pending || refreshing} onClick={refresh}>
            계약 목록 다시 조회
          </Button>
        )}
        {review && row ? (
          <section className="form-grid">
            <h3 ref={heading} tabIndex={-1}>
              변경 내용 검토
            </h3>
            <p>
              계약 ID: <code className="model-governance-value">{row.id}</code>
            </p>
            <p>0은 해당 기준을 검사하지 않는다는 뜻입니다. 아래 값을 기존 계약에 저장합니다.</p>
            <div className="data-table-scroll" tabIndex={0} aria-label="계약 변경 비교 표 영역">
              <table className="data-table model-contract-diff">
                <caption className="sr-only">모델 계약 변경 전후 비교</caption>
                <thead>
                  <tr>
                    <th scope="col">항목</th>
                    <th scope="col">열 때의 값</th>
                    <th scope="col">저장할 값</th>
                    <th scope="col">변경</th>
                  </tr>
                </thead>
                <tbody>
                  {contractFields.map(([key, label]) => {
                    const before = row[key];
                    const after = review[key];
                    const display = (value: unknown) =>
                      typeof value === "boolean" ? (value ? "사용" : "중지") : String(value ?? "") || "없음";
                    return (
                      <tr key={key}>
                        <th scope="row">{label}</th>
                        <td>{display(before)}</td>
                        <td>{display(after)}</td>
                        <td>{before === after ? "변경 없음" : "변경됨"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ) : (
          <fieldset className="form-grid form-dialog-fields" disabled={guard.pending || reason !== undefined}>
            {contractFields
              .filter(([key]) => key !== "enabled")
              .map(([key, label]) => (
                <FormField
                  key={key}
                  label={label}
                  required={key === "name"}
                  error={form.formState.errors[key]?.message}
                  description={
                    key === "task_type"
                      ? "예: code_review, sql, summary"
                      : key === "min_quality_score"
                        ? "일반적인 품질 점수 범위는 0~100입니다."
                        : key === "min_golden_pass_rate" || key === "min_success_rate"
                          ? "비율은 일반적으로 0~1입니다. 0은 검사하지 않음을 뜻합니다."
                          : undefined
                  }
                >
                  {(control) => (
                    <Input
                      {...control}
                      inputMode={
                        key === "name" || key === "task_type"
                          ? undefined
                          : key === "max_latency_ms"
                            ? "numeric"
                            : "decimal"
                      }
                      {...form.register(key)}
                    />
                  )}
                </FormField>
              ))}
            <Checkbox label="계약 사용" {...form.register("enabled")} />
          </fieldset>
        )}
        {error ? (
          <p role="alert" className="form-error">
            {error.message}
            {error.requestId ? <span className="request-id"> 요청 ID: {error.requestId}</span> : null}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
