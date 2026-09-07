import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import { migrationStatusLabels, uiLabels } from "@/config/ui-labels";
import { Badge } from "@/shared/components/ui/Badge";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";

interface PageHeaderProps {
  /** Right-aligned controls: refresh, create, export. */
  actions?: ReactNode;
  description?: ReactNode;
  /** Small label above the title; defaults to the migration status. */
  eyebrow?: ReactNode;
  /** `/admin#/...` route of the equivalent Legacy screen. */
  legacyHref?: `/admin${string}`;
  readOnly?: boolean;
  status?: keyof typeof migrationStatusLabels;
  title: ReactNode;
}

/**
 * Standard page heading: status eyebrow, title, description and actions, plus
 * the "open in Legacy" link whenever the operator may use the Legacy console.
 */
export function PageHeader({
  actions,
  description,
  eyebrow,
  legacyHref,
  readOnly = false,
  status = "preview",
  title,
}: PageHeaderProps): React.JSX.Element {
  const auth = useAuth();
  const showLegacy = legacyHref !== undefined && canOpenLegacyAdmin(auth);
  return (
    <header className="page-header">
      <div>
        <div className="eyebrow">{eyebrow ?? migrationStatusLabels[status]}</div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="page-actions">
        {readOnly ? <Badge tone="info">{uiLabels.readOnly}</Badge> : null}
        {showLegacy ? (
          <a className="button button-secondary button-default" href={legacyHref}>
            기존 화면에서 열기 <ExternalLink aria-hidden="true" />
          </a>
        ) : null}
        {actions}
      </div>
    </header>
  );
}
