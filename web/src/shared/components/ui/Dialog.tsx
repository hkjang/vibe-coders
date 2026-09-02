import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode, RefObject } from "react";

import { Button } from "@/shared/components/ui/Button";

interface DialogProps {
  children: ReactNode;
  description: string;
  footer?: ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  title: string;
}

export function Dialog({
  children,
  description,
  footer,
  onOpenChange,
  open,
  returnFocusRef,
  title,
}: DialogProps): React.JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay" />
        <DialogPrimitive.Content
          className="dialog-content"
          onCloseAutoFocus={(event) => {
            const requestedTarget = returnFocusRef.current;
            const returnTarget =
              requestedTarget?.isConnected && !requestedTarget.matches(":disabled")
                ? requestedTarget
                : (document.querySelector<HTMLElement>("#main-content") ?? document.body);
            event.preventDefault();
            returnTarget.focus();
          }}
        >
          <header className="dialog-header">
            <div>
              <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
              <DialogPrimitive.Description>{description}</DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" aria-label="대화상자 닫기">
                <X aria-hidden="true" />
              </Button>
            </DialogPrimitive.Close>
          </header>
          <div className="dialog-body">{children}</div>
          {footer ? <footer className="dialog-footer">{footer}</footer> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
