import { forwardRef, type SelectHTMLAttributes } from "react";

import { cn } from "@/shared/utils/cn";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options?: ReadonlyArray<SelectOption>;
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { children, className, options, placeholder, ...props },
  ref,
) {
  return (
    <select ref={ref} className={cn("input select", className)} {...props}>
      {placeholder !== undefined ? (
        <option value="" disabled={props.required}>
          {placeholder}
        </option>
      ) : null}
      {options?.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
      {children}
    </select>
  );
});
