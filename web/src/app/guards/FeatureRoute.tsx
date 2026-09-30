import type { ReactNode } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import { resolveFeature, type MigrationFeature } from "@/config/migration-registry";
import { LegacyFeaturePage } from "@/features/legacy/LegacyFeaturePage";
import { FeatureUnavailable, PermissionDenied } from "@/shared/components/state/PageStates";
import { FeatureAccessContext } from "@/shared/feature-access/context";

interface FeatureRouteProps {
  feature: MigrationFeature;
  children?: ReactNode;
}

export function FeatureRoute({ feature, children }: FeatureRouteProps): React.JSX.Element {
  const { user, backendVersion, features, legacyFallback } = useAuth();
  const runtimeFeature = features.find((candidate) => candidate.featureId === feature.featureId) ?? feature;
  const effective = resolveFeature(runtimeFeature, user, backendVersion, { legacyFallback });
  if (!effective.permitted) {
    const missingPermission =
      effective.reason === "permission_denied" || effective.reason === runtimeFeature.requiredPermission
        ? runtimeFeature.requiredPermission
        : undefined;
    return effective.reason === "ui_not_implemented" || effective.reason === "legacy_fallback_disabled" ? (
      <FeatureUnavailable />
    ) : (
      <PermissionDenied permission={missingPermission} reason={effective.reason} />
    );
  }
  if (effective.status === "legacy") return <LegacyFeaturePage feature={runtimeFeature} />;
  return (
    <FeatureAccessContext.Provider
      value={{
        featureId: runtimeFeature.featureId,
        readOnly: effective.readOnly,
        permitted: effective.permitted,
      }}
    >
      {children ?? <FeatureUnavailable />}
    </FeatureAccessContext.Provider>
  );
}
