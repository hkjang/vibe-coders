import { forwardRef, type TextareaHTMLAttributes } from "react";

import { cn } from "@/shared/utils/cn";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, rows = 4, ...props },
  ref,
) {
  return <textarea ref={ref} rows={rows} className={cn("input textarea", className)} {...props} />;
});
