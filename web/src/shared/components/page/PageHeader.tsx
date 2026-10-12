import { LegacyLink } from "@/shared/components/ui/LegacyLink";

import { ExternalLink } from "lucide-react";
import { useContext, type ReactNode } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import { migrationStatusLabels, uiLabels } from "@/config/ui-labels";
import { Badge } from "@/shared/components/ui/Badge";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";

interface PageHeaderProps {
  /** Right-aligned controls: refresh, create, export. */
  actions?: ReactNode;
  description?: ReactNode;
  /** Optional section label; the route's migration status remains visible. */
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
  const access = useContext(FeatureAccessContext);
  // Share the guard's resolved state with navigation; do not resolve a second
  // policy from the URL or allow a stale screen prop to override runtime state.
  const effectiveStatus = access?.permitted ? (access.status ?? status) : status;
  const effectiveReadOnly = readOnly || access?.readOnly === true || effectiveStatus === "preview_read_only";
  const showLegacy = legacyHref !== undefined && canOpenLegacyAdmin(auth);
  return (
    <header className="page-header">
      <div>
        <div className="eyebrow" role="status" aria-label="화면 전환 상태">
          {eyebrow}
          {eyebrow && " · "}
          {migrationStatusLabels[effectiveStatus]}
        </div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="page-actions">
        {effectiveReadOnly ? <Badge tone="info">{uiLabels.readOnly}</Badge> : null}
        {showLegacy ? (
          <LegacyLink className="button button-secondary button-default" href={legacyHref}>
            기존 화면에서 열기 <ExternalLink aria-hidden="true" />
          </LegacyLink>
        ) : null}
        {actions}
      </div>
    </header>
  );
}
