import { useContext, type ReactNode } from "react";

import type { MigrationStatus } from "@/config/migration-registry";
import { migrationStatusLabels, uiLabels } from "@/config/ui-labels";
import { Badge } from "@/shared/components/ui/Badge";
import { FeatureAccessContext } from "@/shared/feature-access/context";

function usePresentation(fallbackStatus: MigrationStatus, readOnly = false) {
  const access = useContext(FeatureAccessContext);
  const status = access?.permitted ? (access.status ?? fallbackStatus) : fallbackStatus;
  return {
    status,
    readOnly: readOnly || access?.readOnly === true || status === "preview_read_only",
  };
}

/** The sidebar passes its own resolved feature; it must not inherit the active route. */
export function MigrationStatusBadge({ status }: { status: MigrationStatus }): React.JSX.Element {
  return <Badge tone={status === "legacy" ? "warning" : "info"}>{migrationStatusLabels[status]}</Badge>;
}

export function MigrationEyebrow({
  fallbackStatus = "preview",
  prefix,
}: {
  fallbackStatus?: MigrationStatus;
  prefix?: ReactNode;
}): React.JSX.Element {
  const { status } = usePresentation(fallbackStatus);
  return (
    <div className="eyebrow" role="status" aria-label="화면 전환 상태">
      {prefix}
      {prefix && " · "}
      {migrationStatusLabels[status]}
    </div>
  );
}

/** A screen may be intrinsically read-only even when its migration state is stable. */
export function FeatureReadOnlyBadge({
  fallbackStatus = "preview",
  readOnly = false,
}: {
  fallbackStatus?: MigrationStatus;
  readOnly?: boolean;
}): React.JSX.Element | null {
  const state = usePresentation(fallbackStatus, readOnly);
  return state.readOnly ? <Badge tone="info">{uiLabels.readOnly}</Badge> : null;
}
