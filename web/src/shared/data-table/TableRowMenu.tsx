import { useLayoutEffect, useRef } from "react";
import "./table-context-menu.css";

export interface TableRowMenuProps {
  x: number;
  y: number;
  label: string;
  returnTo: HTMLButtonElement;
  onClose: () => void;
  onAction: () => void;
}

/** Loaded only after a row-menu gesture. Native top-layer rendering avoids clipping. */
export function TableRowMenu({ x, y, label, returnTo, onClose, onAction }: TableRowMenuProps) {
  const menu = useRef<HTMLDivElement>(null);
  const item = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  const lifetime = useRef(0);
  useLayoutEffect(() => {
    close.current = onClose;
  });
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const generation = lifetime.current + 1;
    lifetime.current = generation;
    element.showPopover();
    const position = () => {
      const bounds = element.getBoundingClientRect();
      element.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
      element.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
    };
    position();
    item.current?.focus({ preventScroll: true });
    const observer = new ResizeObserver(position);
    observer.observe(element);
    const anchor = returnTo.getBoundingClientRect();
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && element.contains(event.target)) return;
      const next = returnTo.getBoundingClientRect();
      if (event.type === "scroll" && anchor.left === next.left && anchor.top === next.top) return;
      close.current();
    };
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("focusin", dismiss, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("focusin", dismiss, true);
      if (element.contains(document.activeElement) || document.activeElement === document.body) {
        // React may remove the row after this layout cleanup. Restore only once
        // that commit finishes, and never override a new menu/dialog's focus.
        queueMicrotask(() => {
          if (lifetime.current !== generation) return;
          if (document.activeElement !== document.body && !element.contains(document.activeElement)) return;
          const target =
            returnTo.isConnected && !returnTo.disabled
              ? returnTo
              : document.querySelector<HTMLElement>("#main-content");
          target?.focus({ preventScroll: true });
        });
      }
    };
  }, [x, y, returnTo]);
  return (
    <div
      ref={menu}
      // Contextmenu can precede pointerup. Native auto light-dismiss would close
      // a cached menu on that same pointerup; outside pointerdown is handled above.
      popover="manual"
      role="menu"
      data-table-row-menu
      aria-label="행 작업"
      className="data-table-context-menu"
      onToggle={(event) => {
        if (event.newState === "closed" && !event.currentTarget.matches(":popover-open")) onClose();
      }}
      onKeyDown={(event) => {
        if (["Escape", "Tab"].includes(event.key)) {
          if (event.key === "Escape") event.preventDefault();
          event.stopPropagation();
          onClose();
          returnTo.focus({ preventScroll: true });
        } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          item.current?.focus();
        }
      }}
    >
      <button
        ref={item}
        type="button"
        role="menuitem"
        className="data-table-context-action"
        onClick={onAction}
      >
        {label}
      </button>
    </div>
  );
}
