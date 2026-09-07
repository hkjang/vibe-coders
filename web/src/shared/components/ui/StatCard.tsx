import type { ReactNode } from "react";

import { cn } from "@/shared/utils/cn";

export type StatTone = "danger" | "default" | "info" | "success" | "warning";

interface StatCardProps {
  className?: string;
  hint?: ReactNode;
  icon?: ReactNode;
  label: ReactNode;
  tone?: StatTone;
  /** Use "—" while the value is unavailable so layout never shifts. */
  value: ReactNode;
}

export function StatCard({
  className,
  hint,
  icon,
  label,
  tone = "default",
  value,
}: StatCardProps): React.JSX.Element {
  return (
    <article className={cn("stat-card", `stat-card-${tone}`, className)}>
      <div className="stat-card-label">
        {icon}
        <span>{label}</span>
      </div>
      <strong className="stat-card-value">{value}</strong>
      {hint ? <span className="stat-card-hint">{hint}</span> : null}
    </article>
  );
}

export function StatGrid({ children, label }: { children: ReactNode; label: string }): React.JSX.Element {
  return (
    <section className="stat-grid" aria-label={label}>
      {children}
    </section>
  );
}
