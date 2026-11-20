import { useLayoutEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { DataTableColumnHelp } from "./columns";
import "./column-tooltip.css";

export interface ColumnTooltipProps {
  anchor: RefObject<HTMLButtonElement | null>;
  id: string;
  label: string;
  help: DataTableColumnHelp;
  onClose: () => void;
  onEnter: () => void;
  onLeave: () => void;
}

/** Deferred until a user focuses, hovers or activates the column help control. */
export function ColumnTooltip({ anchor, id, label, help, onClose, onEnter, onLeave }: ColumnTooltipProps) {
  const tip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const button = anchor.current;
    const tooltip = tip.current;
    if (!button || !tooltip) return;
    if (typeof tooltip.showPopover === "function") tooltip.showPopover();
    const position = () => {
      const bounds = button.getBoundingClientRect();
      const clip = button.closest(".data-table-scroll")?.getBoundingClientRect();
      if (
        bounds.width > 0 &&
        (bounds.right <= (clip?.left ?? 0) ||
          bounds.left >= (clip?.right ?? innerWidth) ||
          bounds.bottom <= 0 ||
          bounds.top >= innerHeight)
      ) {
        onClose();
        return;
      }
      const size = tooltip.getBoundingClientRect();
      tooltip.style.left = `${Math.max(8, Math.min(bounds.left, innerWidth - size.width - 8))}px`;
      const below = bounds.bottom + 8;
      tooltip.style.top = `${Math.max(8, below + size.height <= innerHeight - 8 ? below : bounds.top - size.height - 8)}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(tooltip);
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && (button.contains(event.target) || tooltip.contains(event.target)))
        return;
      onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("focusin", dismiss, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("focusin", dismiss, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div
      ref={tip}
      id={id}
      role="tooltip"
      popover={typeof HTMLElement.prototype.showPopover === "function" ? "manual" : undefined}
      className="data-table-column-help"
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      <strong>
        {label}
        {help.unit ? ` · ${help.unit}` : ""}
      </strong>
      <p>{help.description}</p>
    </div>,
    anchor.current?.closest('[role="dialog"], main, [role="main"]') ?? document.body,
  );
}
