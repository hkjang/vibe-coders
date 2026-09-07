import { useId, useState, type ReactNode, type RefObject } from "react";
import type { FieldValues, UseFormReturn } from "react-hook-form";

import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

interface FormDialogProps<Input extends FieldValues, Output> {
  children: ReactNode;
  description: string;
  form: UseFormReturn<Input, unknown, Output>;
  onOpenChange: (open: boolean) => void;
  /** Resolve to close the dialog; throw (or reject) to keep it open with the error. */
  onSubmit: (values: Output) => Promise<unknown> | unknown;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  submitLabel?: string;
  title: string;
}

/**
 * Dialog around a react-hook-form form. Field components render inside as
 * children; submission errors from the API show inline with the request ID.
 */
export function FormDialog<Input extends FieldValues, Output>({
  children,
  description,
  form,
  onOpenChange,
  onSubmit,
  open,
  returnFocusRef,
  submitLabel = "저장",
  title,
}: FormDialogProps<Input, Output>): React.JSX.Element {
  const formId = useId();
  const [error, setError] = useState<{ message: string; requestId?: string } | undefined>();
  const pending = form.formState.isSubmitting;
  const close = (next: boolean): void => {
    if (!next) setError(undefined);
    onOpenChange(next);
  };

  const submit = form.handleSubmit(async (values) => {
    setError(undefined);
    try {
      await onSubmit(values);
      close(false);
    } catch (cause) {
      setError({
        message: safeAppErrorMessage(cause, "저장하지 못했습니다."),
        requestId: isAppError(cause) ? cause.requestId : undefined,
      });
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) close(next);
      }}
      title={title}
      description={description}
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <Button variant="secondary" onClick={() => close(false)} disabled={pending}>
            취소
          </Button>
          <Button form={formId} type="submit" variant="primary" disabled={pending}>
            {pending ? "저장 중" : submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} className="form-grid" noValidate onSubmit={(event) => void submit(event)}>
        {children}
        {error ? (
          <p className="form-error" role="alert">
            {error.message}
            {error.requestId ? <span className="request-id"> 요청 ID: {error.requestId}</span> : null}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
