import { useEffect, useId, useRef, useState, type RefObject } from "react";
import "@/features/gateway/providers/provider-review.css";

import { ProviderChangeReview } from "@/features/gateway/providers/ProviderChangeReview";
import { ProviderDraftBoundary } from "@/features/gateway/providers/ProviderDraftBoundary";
import { ProviderFormFields } from "@/features/gateway/providers/ProviderFormFields";
import { ProviderImpactPanel } from "@/features/gateway/providers/ProviderImpactPanel";
import { useProviderImpact } from "@/features/gateway/providers/use-provider-impact";
import type { ProviderCatalogRow } from "@/features/gateway/providers/provider-catalog";
import {
  providerEditSchema,
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
}: Props): React.JSX.Element {
  // Background list refreshes never replace the baseline or the reviewed payload.
  const [row] = useState(initialRow);
  const form = useZodForm<ProviderFormInput, ProviderFormOutput>(
    providerEditSchema(row),
    providerFormValues(row),
  );
  const { setValue, setFocus } = form;
  const [review, setReview] = useState<ProviderWriteBody>();
  const [error, setError] = useState<{ message: string; requestId?: string }>();
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
  const impact = useProviderImpact(row.identity, review !== undefined, guard.pending);

  useEffect(() => {
    if (initialEnabled !== undefined) setValue("enabled", initialEnabled, { shouldDirty: true });
  }, [initialEnabled, setValue]);
  useEffect(() => {
    if (review) heading.current?.focus();
    else setFocus("base_url");
  }, [review, setFocus]);

  const fail = (cause: unknown): void =>
    setError({
      message: safeAppErrorMessage(cause, "공급자 설정을 저장하지 못했습니다."),
      requestId: isAppError(cause) ? cause.requestId : undefined,
    });
  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setError(undefined);
    if (review) {
      if (!impact.canSubmit()) return;
      // Inputs are absent while reviewing. Send this exact approved object,
      // never re-read a mutable form or a refreshed row after confirmation.
      void guard.run(() => onSubmit(review), fail);
    } else {
      void guard.run(
        async () => {
          let body: ProviderWriteBody | undefined;
          await form.handleSubmit((values) => {
            body = providerWriteBody(values);
          })();
          return body;
        },
        fail,
        (body) => {
          if (body) setReview(body);
        },
      );
    }
  };

  return (
    <Dialog
      open
      title="공급자 수정"
      description="변경 내용을 검토한 다음 저장합니다. API 키 원문은 비교에 표시하지 않습니다."
      onOpenChange={(open) => {
        if (!open) guard.requestClose();
      }}
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <Button variant="secondary" disabled={guard.pending} onClick={() => guard.requestClose()}>
            취소
          </Button>
          {review ? (
            <Button
              variant="secondary"
              disabled={guard.pending}
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
            disabled={guard.pending || (review !== undefined && !impact.canConfirm)}
          >
            {guard.pending ? "처리 중" : review ? "검토한 내용 저장" : "변경 내용 검토"}
          </Button>
        </>
      }
    >
      <form id={formId} className="form-grid provider-review-form" noValidate onSubmit={submit}>
        {review ? (
          <section className="form-grid">
            <h3 ref={heading} tabIndex={-1}>
              변경 내용 검토
            </h3>
            <ProviderChangeReview row={row} body={review} credentialPrefixes={credentialPrefixes} />
            <ProviderImpactPanel
              review={impact}
              pending={guard.pending}
              credentialPrefixes={credentialPrefixes}
            />
          </section>
        ) : (
          <fieldset className="form-grid form-dialog-fields" disabled={guard.pending} aria-label="입력 항목">
            <ProviderFormFields form={form} row={row} />
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
