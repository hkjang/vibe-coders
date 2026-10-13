import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { Textarea } from "@/shared/components/ui/Textarea";
import { Input } from "@/shared/components/ui/Input";
import { FormField } from "@/shared/components/form/FormField";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { isAppError } from "@/shared/api/error";

interface ConfirmDialogProps {
  cancelLabel?: string;
  children?: ReactNode;
  confirmLabel?: string;
  /** Optional current prerequisite; preserves the draft reason and cancel/close actions. */
  confirmDisabled?: boolean;
  description: string;
  /** Route-owned, allowlisted messages; never return a raw server error. */
  errorFormatter?: typeof safeAppErrorMessage;
  onConfirm: (reason: string, target?: string) => Promise<unknown> | unknown;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  /** Ask the operator for a change reason that is sent with the mutation. */
  requireReason?: boolean;
  /** Exact local confirmation phrase; never sent to an API by this component. */
  requireTarget?: string;
  returnFocusRef: RefObject<HTMLElement | null>;
  title: string;
  tone?: "danger" | "primary";
}

/**
 * Confirmation step for destructive or audited actions. Runs `onConfirm`, shows
 * its failure inline with the request ID, and closes only on success.
 */
export function ConfirmDialog(props: ConfirmDialogProps): React.JSX.Element {
  // Only typed-target callers opt into a fresh review when its target or open
  // lifetime changes. Existing reason-only callers keep their component lifetime.
  return (
    <Confirmation
      key={props.requireTarget === undefined ? "default" : JSON.stringify([props.open, props.requireTarget])}
      {...props}
    />
  );
}

function Confirmation({
  cancelLabel = "취소",
  children,
  confirmLabel = "확인",
  confirmDisabled = false,
  description,
  errorFormatter = safeAppErrorMessage,
  onConfirm,
  onOpenChange,
  open,
  requireReason = false,
  requireTarget,
  returnFocusRef,
  title,
  tone = "primary",
}: ConfirmDialogProps): React.JSX.Element {
  const [reason, setReason] = useState("");
  const [target, setTarget] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; requestId?: string } | undefined>();
  const mounted = useRef(true);
  const sending = useRef(false);
  const currentInput = useRef({ reason, target });
  useLayoutEffect(() => {
    currentInput.current = { reason, target };
  }, [reason, target]);
  const confirmationAllowed = useRef(!confirmDisabled);
  useLayoutEffect(() => {
    confirmationAllowed.current = !confirmDisabled;
  }, [confirmDisabled]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const close = (next: boolean): void => {
    if (!next) {
      setReason("");
      setTarget("");
      setError(undefined);
    }
    onOpenChange(next);
  };
  const reasonMissing = requireReason && reason.trim() === "";
  const targetMissing = requireTarget !== undefined && target !== requireTarget;

  const confirm = async (): Promise<void> => {
    if (
      requireTarget !== undefined &&
      (!mounted.current ||
        !open ||
        sending.current ||
        currentInput.current.reason !== reason ||
        currentInput.current.target !== target)
    )
      return;
    if (!confirmationAllowed.current || reasonMissing || targetMissing || pending) return;
    sending.current = true;
    setPending(true);
    setError(undefined);
    try {
      if (requireTarget === undefined) await onConfirm(reason.trim());
      else await onConfirm(reason.trim(), target);
      if (mounted.current) close(false);
    } catch (cause) {
      if (!mounted.current) return;
      setError({
        message: errorFormatter(cause, "작업을 완료하지 못했습니다."),
        requestId: isAppError(cause) ? cause.requestId : undefined,
      });
    } finally {
      if (mounted.current) {
        sending.current = false;
        setPending(false);
      }
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
            disabled={pending || reasonMissing || targetMissing || confirmDisabled}
          >
            {pending ? "처리 중" : confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {requireTarget !== undefined ? (
        <FormField
          label="확인 문구"
          required
          description={`대상을 확인하려면 ‘${requireTarget}’를 정확히 입력하세요.`}
        >
          {(control) => (
            <Input
              {...control}
              autoComplete="off"
              value={target}
              disabled={confirmDisabled || pending}
              onChange={(event) => setTarget(event.target.value)}
            />
          )}
        </FormField>
      ) : null}
      {requireReason ? (
        <FormField label="변경 사유" required>
          {(control) => (
            <Textarea
              {...control}
              rows={2}
              value={reason}
              disabled={confirmDisabled}
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
