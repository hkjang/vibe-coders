import type { HTMLAttributes } from "react";

import { cn } from "@/shared/utils/cn";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: "danger" | "info" | "muted" | "success" | "warning";
}

export function Badge({ className, tone = "muted", ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn("badge", `badge-${tone}`, className)} {...props} />;
}
