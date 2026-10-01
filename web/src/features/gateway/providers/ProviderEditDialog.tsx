import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import "@/features/gateway/providers/provider-review.css";

import { ProviderChangeReview } from "@/features/gateway/providers/ProviderChangeReview";
import { ProviderDraftBoundary } from "@/features/gateway/providers/ProviderDraftBoundary";
import { ProviderFormFields } from "@/features/gateway/providers/ProviderFormFields";
import { ProviderImpactPanel } from "@/features/gateway/providers/ProviderImpactPanel";
import { ProviderConnectionPanel } from "./ProviderConnectionPanel";
import { useProviderConnection } from "./use-provider-connection";
import { useProviderImpact } from "@/features/gateway/providers/use-provider-impact";
import type { ProviderCatalogRow } from "@/features/gateway/providers/provider-catalog";
import {
  providerEditSchema,
  providerFormSchema,
  providerFormValues,
  providerWriteBody,
  type ProviderFormInput,
  type ProviderFormOutput,
} from "@/features/gateway/providers/provider-form";
import type { ProviderWriteBody } from "@/shared/api/domains/gateway";
import { isAppError } from "@/shared/api/error";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useDraftGuard } from "@/shared/unsaved/use-draft-guard";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { useProviderWriteAccess } from "./use-provider-write-access";

interface Props {
  row: ProviderCatalogRow;
  credentialPrefixes?: readonly string[];
  initialEnabled?: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (body: ProviderWriteBody) => Promise<unknown>;
  returnFocusRef: RefObject<HTMLElement | null>;
}

export function ProviderEditDialog(props: Props): React.JSX.Element {
  return (
    <ProviderDraftBoundary>
      <ProviderEditor {...props} />
    </ProviderDraftBoundary>
  );
}

function ProviderEditor({
  row: initialRow,
  credentialPrefixes,
  initialEnabled,
  onOpenChange,
  onSubmit,
  returnFocusRef,
}: Omit<Props, "row"> & { row?: ProviderCatalogRow }): React.JSX.Element {
  const access = useProviderWriteAccess();
  // Background list refreshes never replace the baseline or the reviewed payload.
  const [row] = useState(initialRow);
  const form = useZodForm<ProviderFormInput, ProviderFormOutput>(
    row ? providerEditSchema(row) : providerFormSchema,
    providerFormValues(row),
  );
  const { setValue, setFocus, watch } = form;
  const formRevision = useRef(0);
  const [review, setReview] = useState<ProviderWriteBody>();
  const [error, setError] = useState<{ message: string; requestId?: string }>();
  const [validating, setValidating] = useState(false);
  const validationRun = useRef<object | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const formId = useId();
  const guard = useDraftGuard({
    dirty: form.formState.isDirty,
    onDiscard: () => {
      form.reset(providerFormValues(row));
      setReview(undefined);
      setError(undefined);
      onOpenChange(false);
    },
  });
  const impact = useProviderImpact(
    row?.identity ?? "",
    row !== undefined && review !== undefined,
    guard.pending,
  );
  const connection = useProviderConnection(form, row, guard);
  const fieldsPending = guard.pending && connection.phase !== "validation" && !validating;
  const savingNewProvider = !row && fieldsPending && connection.phase === "idle";

  useLayoutEffect(
    () => () => {
      validationRun.current = undefined;
    },
    [],
  );

  useEffect(() => {
    const subscription = watch(() => {
      formRevision.current += 1;
    });
    return () => subscription.unsubscribe();
  }, [watch]);

  useEffect(() => {
    if (initialEnabled !== undefined) setValue("enabled", initialEnabled, { shouldDirty: true });
  }, [initialEnabled, setValue]);
  useEffect(() => {
    if (review) heading.current?.focus();
    else setFocus(row ? "base_url" : "name");
  }, [review, row, setFocus]);

  const fail = (cause: unknown): void =>
    setError({
      message: safeAppErrorMessage(cause, "공급자 설정을 저장하지 못했습니다."),
      requestId: isAppError(cause) ? cause.requestId : undefined,
    });
  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    try {
      access.assertCurrent();
    } catch (cause) {
      fail(cause);
      return;
    }
    setError(undefined);
    if (review) {
      if (!impact.canSubmit()) return;
      // Inputs are absent while reviewing. Send this exact approved object,
      // never re-read a mutable form or a refreshed row after confirmation.
      void guard.run(() => {
        access.assertCurrent();
        return onSubmit(review);
      }, fail);
    } else {
      const runToken = {};
      const completion = guard.run(
        async () => {
          let body: ProviderWriteBody | undefined;
          const revision = formRevision.current;
          validationRun.current = runToken;
          setValidating(true);
          await form.handleSubmit((values) => {
            body = providerWriteBody(values);
          })();
          access.assertCurrent();
          if (revision !== formRevision.current) {
            setError({ message: "검증 중 입력이 달라졌습니다. 현재 내용을 다시 확인하세요." });
            return undefined;
          }
          if (body && !row) {
            setValidating(false);
            await onSubmit(body);
          }
          return body;
        },
        fail,
        (body) => {
          if (body) {
            if (row) {
              access.assertCurrent();
              setReview(body);
            } else {
              // Creation retains its existing direct-save behavior. Testing
              // uses a different type=button operation and never enters here.
              form.reset(providerFormValues());
              onOpenChange(false);
            }
          }
        },
      );
      void completion.finally(() => {
        if (validationRun.current === runToken) {
          validationRun.current = undefined;
          // RHF's first error stays focusable through guard settlement.
          setValidating(false);
        }
      });
    }
  };

  return (
    <Dialog
      open
      title={row ? "공급자 수정" : "공급자 추가"}
      description={
        row
          ? "변경 내용을 검토한 다음 저장합니다. API 키 원문은 비교에 표시하지 않습니다."
          : "이름과 기본 URL은 필수입니다. 연결 테스트와 저장은 별도 작업이며 API 키는 입력 전용입니다."
      }
      onOpenChange={(open) => {
        if (!open) guard.requestClose();
      }}
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <Button variant="secondary" disabled={guard.pending} onClick={() => guard.requestClose()}>
            취소
          </Button>
          {!review ? (
            <Button
              type="button"
              variant="secondary"
              aria-disabled={guard.pending || !access.allowed}
              aria-busy={connection.phase !== "idle"}
              onClick={() => connection.run()}
            >
              {connection.phase !== "idle" ? "연결 확인 중" : "연결 테스트"}
            </Button>
          ) : null}
          {review ? (
            <Button
              variant="secondary"
              disabled={guard.pending || !access.allowed}
              onClick={() => {
                impact.resetAcknowledgement();
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
            disabled={guard.pending || !access.allowed || (review !== undefined && !impact.canConfirm)}
          >
            {guard.pending
              ? savingNewProvider
                ? "저장 중"
                : "처리 중"
              : review
                ? "검토한 내용 저장"
                : row
                  ? "변경 내용 검토"
                  : "저장"}
          </Button>
        </>
      }
    >
      <form id={formId} className="form-grid provider-review-form" noValidate onSubmit={submit}>
        {!access.allowed ? <InlineNotice tone="warning">{access.reason}</InlineNotice> : null}
        {review && row ? (
          <section className="form-grid">
            <h3 ref={heading} tabIndex={-1}>
              변경 내용 검토
            </h3>
            <ProviderChangeReview row={row} body={review} credentialPrefixes={credentialPrefixes} />
            <ProviderImpactPanel
              review={impact}
              pending={guard.pending}
              readOnly={!access.allowed}
              credentialPrefixes={credentialPrefixes}
            />
          </section>
        ) : (
          <fieldset
            className="form-grid form-dialog-fields"
            disabled={fieldsPending || !access.allowed}
            aria-label="입력 항목"
          >
            <ProviderFormFields form={form} row={row} />
          </fieldset>
        )}
        {!review ? (
          <ProviderConnectionPanel
            connection={connection}
            disabled={guard.pending || !access.allowed}
            credentialPrefixes={credentialPrefixes}
          />
        ) : null}
        <p tabIndex={0} className="provider-connection-scroll-hint">
          입력과 연결 결과는 이 영역에서 위아래 방향키로 스크롤해 확인할 수 있습니다.
        </p>
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

export function ProviderCreateDialog(props: Omit<Props, "row">): React.JSX.Element {
  return (
    <ProviderDraftBoundary>
      <ProviderEditor {...props} />
    </ProviderDraftBoundary>
  );
}
