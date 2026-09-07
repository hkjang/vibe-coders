import { Inbox } from "lucide-react";
import type { ReactNode } from "react";

interface EmptyStateProps {
  actions?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  title: ReactNode;
}

/** Tells the operator there is nothing here yet and what creates the first item. */
export function EmptyState({ actions, description, icon, title }: EmptyStateProps): React.JSX.Element {
  return (
    <div className="empty-state" role="status">
      {icon ?? <Inbox aria-hidden="true" />}
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {actions ? <div className="empty-state-actions">{actions}</div> : null}
    </div>
  );
}
