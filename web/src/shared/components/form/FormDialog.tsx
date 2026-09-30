import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { FieldValues, UseFormReturn } from "react-hook-form";

import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useUnsavedChanges } from "@/shared/unsaved/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";

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
  /** External prerequisites may block submission without locking draft edits. */
  submitDisabled?: boolean;
  /** Optional plain-text keyboard scroll target, outside pending-disabled inputs. */
  scrollHint?: string;
  title: string;
}

/**
 * Dialog around a react-hook-form form. Field components render inside as
 * children; submission errors from the API show inline with the request ID.
 */
export function FormDialog<Input extends FieldValues, Output>(
  props: FormDialogProps<Input, Output>,
): React.JSX.Element {
  const coordinator = useUnsavedChanges();
  // Existing standalone screen/MemoryRouter consumers retain close and unload protection.
  return coordinator ? (
    <GuardedFormDialog {...props} />
  ) : (
    <UnsavedChangesProvider>
      <GuardedFormDialog {...props} />
    </UnsavedChangesProvider>
  );
}

function GuardedFormDialog<Input extends FieldValues, Output>({
  children,
  description,
  form,
  onOpenChange,
  onSubmit,
  open,
  returnFocusRef,
  submitLabel = "저장",
  submitDisabled = false,
  scrollHint,
  title,
}: FormDialogProps<Input, Output>): React.JSX.Element {
  const coordinator = useUnsavedChanges();
  if (!coordinator) throw new Error("FormDialog requires an unsaved changes coordinator");
  const formId = useId();
  const [guardId] = useState(() => Symbol("form"));
  const submitting = useRef(false);
  const submissionAllowed = useRef(!submitDisabled);
  const epoch = useRef(0);
  const mounted = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; requestId?: string } | undefined>();
  const dirty = form.formState.isDirty;
  useLayoutEffect(() => {
    submissionAllowed.current = !submitDisabled;
  }, [submitDisabled]);
  const close = useCallback((): void => {
    // Invalidate immediately, including a logout and mutation resolution in the
    // same tick before React commits the closed state.
    epoch.current += 1;
    coordinator.removeForm(guardId);
    setError(undefined);
    onOpenChange(false);
  }, [coordinator, guardId, onOpenChange]);

  useLayoutEffect(() => {
    if (open) coordinator.setForm(guardId, { dirty, pending: pending || submitting.current, discard: close });
    else coordinator.removeForm(guardId);
  }, [close, coordinator, dirty, guardId, open, pending]);
  useLayoutEffect(() => {
    epoch.current += 1;
  }, [open]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current += 1;
      coordinator.removeForm(guardId);
    };
  }, [coordinator, guardId]);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!submissionAllowed.current || submitting.current || !coordinator.startSubmission(guardId)) return;
    submitting.current = true;
    setPending(true);
    const submissionEpoch = epoch.current;
    const isCurrent = (): boolean => mounted.current && epoch.current === submissionEpoch;
    try {
      await form.handleSubmit(async (values) => {
        if (!isCurrent() || !submissionAllowed.current) return;
        setError(undefined);
        try {
          await onSubmit(values);
          if (isCurrent()) close();
        } catch (cause) {
          if (isCurrent())
            setError({
              message: safeAppErrorMessage(cause, "저장하지 못했습니다."),
              requestId: isAppError(cause) ? cause.requestId : undefined,
            });
        }
      })(event);
    } finally {
      submitting.current = false;
      if (mounted.current) setPending(false);
      // A security close may reopen this same instance before the old request
      // settles. Its sole flight still owns pending; the ref above forbids any
      // newer submission until here, so releasing it cannot clear a new flight.
      coordinator.finishSubmission(guardId);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else coordinator.requestClose(guardId);
      }}
      title={title}
      description={description}
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <Button variant="secondary" onClick={() => coordinator.requestClose(guardId)} disabled={pending}>
            취소
          </Button>
          <Button form={formId} type="submit" variant="primary" disabled={pending || submitDisabled}>
            {pending ? "저장 중" : submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} className="form-grid" noValidate onSubmit={(event) => void submit(event)}>
        <fieldset className="form-grid form-dialog-fields" disabled={pending} aria-label="입력 항목">
          {children}
        </fieldset>
        {scrollHint !== undefined ? (
          <p className="field-description" tabIndex={0}>
            {scrollHint}
          </p>
        ) : null}
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
