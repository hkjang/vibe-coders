import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode, RefObject } from "react";

import { Button } from "@/shared/components/ui/Button";

interface SheetProps {
  children: ReactNode;
  description: string;
  footer?: ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  title: ReactNode;
  /** Wide sheets suit tables and JSON; default suits forms. */
  size?: "default" | "wide";
  /** Label a keyboard scroll target for long, read-only content. */
  scrollLabel?: string;
}

/** Side panel for detail views and editors that should keep the list visible. */
export function Sheet({
  children,
  description,
  footer,
  onOpenChange,
  open,
  returnFocusRef,
  size = "default",
  scrollLabel,
  title,
}: SheetProps): React.JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay" />
        <DialogPrimitive.Content
          onEscapeKeyDown={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest("[data-code-editor-surface],[data-table-row-menu]")
            )
              event.preventDefault();
          }}
          className="sheet-content"
          data-size={size}
          onCloseAutoFocus={(event) => {
            const target = returnFocusRef.current;
            event.preventDefault();
            (target?.isConnected
              ? target
              : (document.querySelector<HTMLElement>("#main-content") ?? document.body)
            ).focus();
          }}
        >
          <header className="dialog-header">
            <div>
              <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
              <DialogPrimitive.Description>{description}</DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" aria-label="패널 닫기">
                <X aria-hidden="true" />
              </Button>
            </DialogPrimitive.Close>
          </header>
          <div
            className="dialog-body sheet-body"
            role={scrollLabel ? "region" : undefined}
            aria-label={scrollLabel}
            tabIndex={scrollLabel ? 0 : undefined}
          >
            {children}
          </div>
          {footer ? <footer className="dialog-footer">{footer}</footer> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
