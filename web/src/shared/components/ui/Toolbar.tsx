import type { ReactNode } from "react";

import { cn } from "@/shared/utils/cn";

interface ToolbarProps {
  children: ReactNode;
  className?: string;
  /** Right-aligned actions such as refresh or create. */
  end?: ReactNode;
  label: string;
}

/** Filter row above a table; wraps controls and keeps actions on the trailing edge. */
export function Toolbar({ children, className, end, label }: ToolbarProps): React.JSX.Element {
  return (
    <div className={cn("toolbar", className)} role="group" aria-label={label}>
      <div className="toolbar-start">{children}</div>
      {end ? <div className="toolbar-end">{end}</div> : null}
    </div>
  );
}
