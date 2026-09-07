import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/shared/utils/cn";

export type NoticeTone = "danger" | "info" | "success" | "warning";

interface InlineNoticeProps {
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  tone?: NoticeTone;
}

const icons: Record<NoticeTone, React.JSX.Element> = {
  danger: <OctagonAlert aria-hidden="true" />,
  info: <Info aria-hidden="true" />,
  success: <CheckCircle2 aria-hidden="true" />,
  warning: <AlertTriangle aria-hidden="true" />,
};

/** Contextual message inside a page; `danger` announces as an alert, others as status. */
export function InlineNotice({
  actions,
  children,
  className,
  title,
  tone = "info",
}: InlineNoticeProps): React.JSX.Element {
  return (
    <div
      className={cn("inline-notice", `inline-notice-${tone}`, className)}
      role={tone === "danger" ? "alert" : "status"}
    >
      {icons[tone]}
      <div className="inline-notice-body">
        {title ? <strong>{title}</strong> : null}
        <div>{children}</div>
      </div>
      {actions ? <div className="inline-notice-actions">{actions}</div> : null}
    </div>
  );
}
