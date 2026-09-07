import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "@/shared/utils/cn";

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "type"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
}

/** Toggle rendered as a `role="switch"` button; the label is visible next to it. */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, className, label, onCheckedChange, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      className={cn("switch", className)}
      onClick={() => onCheckedChange(!checked)}
      {...props}
    >
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      <span className="switch-label">{label}</span>
    </button>
  );
});
