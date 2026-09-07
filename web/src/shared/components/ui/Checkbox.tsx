import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";

import { cn } from "@/shared/utils/cn";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  description?: ReactNode;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, description, label, ...props },
  ref,
) {
  return (
    <label className={cn("checkbox", className)}>
      <input ref={ref} type="checkbox" {...props} />
      <span className="checkbox-copy">
        <span>{label}</span>
        {description ? <small>{description}</small> : null}
      </span>
    </label>
  );
});
