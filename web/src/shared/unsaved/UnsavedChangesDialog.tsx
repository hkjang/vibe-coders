import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef } from "react";

import { Button } from "@/shared/components/ui/Button";

interface Props {
  open: boolean;
  pending: boolean;
  onKeepEditing: () => void;
  onDiscard: () => void;
}

export function UnsavedChangesDialog({ open, pending, onKeepEditing, onDiscard }: Props): React.JSX.Element {
  const continueButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreEditingFocus = useRef(false);
  useEffect(() => {
    if (open) return;
    // An overlay pointer-down may blur the input before the confirmation opens.
    // Retain the last actual focus target, never body/the non-focusable overlay.
    const rememberFocus = (event: FocusEvent): void => {
      if (
        event.target instanceof HTMLElement &&
        event.target !== document.body &&
        !event.target.closest('[role="alertdialog"]')
      )
        returnFocus.current = event.target;
    };
    document.addEventListener("focusin", rememberFocus);
    return () => document.removeEventListener("focusin", rememberFocus);
  }, [open]);
  const keepEditing = (): void => {
    restoreEditingFocus.current = true;
    onKeepEditing();
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) keepEditing();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          role="alertdialog"
          className="dialog-content"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            restoreEditingFocus.current = false;
            if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body)
              returnFocus.current = document.activeElement;
            continueButton.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // Discard/security/navigation close the underlying form too; its
            // own trigger/route focus restoration must remain authoritative.
            if (!restoreEditingFocus.current) return;
            const target = returnFocus.current;
            if (target?.isConnected && !target.matches(":disabled")) target.focus();
          }}
        >
          <header className="dialog-header">
            <div>
              <Dialog.Title>저장하지 않은 변경사항이 있습니다</Dialog.Title>
              <Dialog.Description>
                {pending
                  ? "저장 중에는 변경을 버리거나 화면을 이동할 수 없습니다. 저장이 끝날 때까지 기다려 주세요."
                  : "변경을 버리면 입력한 내용이 사라집니다. 계속 편집하거나 변경을 버리고 진행하세요."}
              </Dialog.Description>
            </div>
          </header>
          <footer className="dialog-footer">
            <Button ref={continueButton} variant="secondary" onClick={keepEditing}>
              계속 편집
            </Button>
            <Button variant="danger" disabled={pending} onClick={onDiscard}>
              변경 버리기
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
