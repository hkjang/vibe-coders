import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { Textarea } from "@/shared/components/ui/Textarea";
import { FormField } from "@/shared/components/form/FormField";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { isAppError } from "@/shared/api/error";

interface ConfirmDialogProps {
  cancelLabel?: string;
  children?: ReactNode;
  confirmLabel?: string;
  description: string;
  onConfirm: (reason: string) => Promise<unknown> | unknown;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  /** Ask the operator for a change reason that is sent with the mutation. */
  requireReason?: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  title: string;
  tone?: "danger" | "primary";
}

/**
 * Confirmation step for destructive or audited actions. Runs `onConfirm`, shows
 * its failure inline with the request ID, and closes only on success.
 */
export function ConfirmDialog({
  cancelLabel = "취소",
  children,
  confirmLabel = "확인",
  description,
  onConfirm,
  onOpenChange,
  open,
  requireReason = false,
  returnFocusRef,
  title,
  tone = "primary",
}: ConfirmDialogProps): React.JSX.Element {
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; requestId?: string } | undefined>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const close = (next: boolean): void => {
    if (!next) {
      setReason("");
      setError(undefined);
    }
    onOpenChange(next);
  };
  const reasonMissing = requireReason && reason.trim() === "";

  const confirm = async (): Promise<void> => {
    if (reasonMissing || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await onConfirm(reason.trim());
      if (mounted.current) close(false);
    } catch (cause) {
      if (!mounted.current) return;
      setError({
        message: safeAppErrorMessage(cause, "작업을 완료하지 못했습니다."),
        requestId: isAppError(cause) ? cause.requestId : undefined,
      });
    } finally {
      if (mounted.current) setPending(false);
    }
  };

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
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={() => void confirm()}
            disabled={pending || reasonMissing}
          >
            {pending ? "처리 중" : confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {requireReason ? (
        <FormField label="변경 사유" required>
          {(control) => (
            <Textarea
              {...control}
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="감사 이력에 남길 사유를 입력하세요."
            />
          )}
        </FormField>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error.message}
          {error.requestId ? <span className="request-id"> 요청 ID: {error.requestId}</span> : null}
        </p>
      ) : null}
    </Dialog>
  );
}
