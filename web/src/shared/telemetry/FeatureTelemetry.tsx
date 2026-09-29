import { useEffect, useMemo, type PropsWithChildren } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import { resolveFeature, type MigrationFeature } from "@/config/migration-registry";
import { createFeatureVisit } from "@/shared/telemetry/visit";
import { LegacyObservationContext } from "@/shared/telemetry/legacy-observation";

export function FeatureTelemetry({
  children,
  feature,
}: PropsWithChildren<{ feature?: MigrationFeature }>): React.JSX.Element {
  const auth = useAuth();
  const effective = feature
    ? resolveFeature(feature, auth.user, auth.backendVersion, { legacyFallback: auth.legacyFallback })
    : undefined;
  const enabled =
    auth.telemetryEnabled === true &&
    auth.uiEnabled &&
    (auth.mode === "authenticated" || auth.mode === "legacy" || auth.mode === "open") &&
    effective?.permitted === true;
  const featureId = feature?.featureId;
  // Identity only resets the in-memory visit when accounts change. It is never sent.
  const identity = auth.user?.id;
  const scope = useMemo(() => ({ featureId, identity }), [featureId, identity]);
  const visit = useMemo(
    () => (enabled && scope.featureId ? createFeatureVisit(scope.featureId) : undefined),
    [enabled, scope],
  );
  useEffect(() => visit?.recordVisit(), [visit]);
  const legacyAllowed = auth.legacyFallback && feature?.fallbackEnabled && effective?.status !== "retired";
  return (
    <LegacyObservationContext.Provider value={legacyAllowed ? visit?.recordLegacyOpen : undefined}>
      {children}
    </LegacyObservationContext.Provider>
  );
}
