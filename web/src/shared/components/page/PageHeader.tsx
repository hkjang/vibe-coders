import { FeatureLegacyLink } from "@/shared/components/ui/FeatureLegacyLink";

import { ExternalLink } from "lucide-react";
import { useContext, type ReactNode } from "react";

import { FeatureAccessContext } from "@/shared/feature-access/context";
import type { MigrationStatus } from "@/config/migration-registry";
import { FeatureReadOnlyBadge, MigrationEyebrow } from "./MigrationStatus";

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
  const access = useContext(FeatureAccessContext);
  const featureId = access?.permitted ? access.featureId : undefined;
  return (
    <header className="page-header">
      <div>
        <MigrationEyebrow fallbackStatus={status} prefix={eyebrow} />
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="page-actions">
        <FeatureReadOnlyBadge readOnly={readOnly} fallbackStatus={status} />
        {legacyHref && featureId ? (
          <FeatureLegacyLink
            featureId={featureId}
            className="button button-secondary button-default"
            href={legacyHref}
          >
            기존 화면에서 열기 <ExternalLink aria-hidden="true" />
          </FeatureLegacyLink>
        ) : null}
        {actions}
      </div>
    </header>
  );
}
