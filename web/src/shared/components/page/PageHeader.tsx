import { LegacyLink } from "@/shared/components/ui/LegacyLink";

import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import type { MigrationStatus } from "@/config/migration-registry";
import { FeatureReadOnlyBadge, MigrationEyebrow } from "./MigrationStatus";
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
  status?: MigrationStatus;
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
        <MigrationEyebrow fallbackStatus={status} prefix={eyebrow} />
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="page-actions">
        <FeatureReadOnlyBadge readOnly={readOnly} fallbackStatus={status} />
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
