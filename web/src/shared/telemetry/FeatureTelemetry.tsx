import { useContext, useEffect, useMemo, type PropsWithChildren } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import { resolveFeature, versionAtLeast, type MigrationFeature } from "@/config/migration-registry";
import { createFeatureVisit } from "@/shared/telemetry/visit";
import { LegacyObservationContext } from "@/shared/telemetry/legacy-observation";
import { RouteLoadContext } from "@/shared/telemetry/route-load-context";

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
  const observer = useContext(RouteLoadContext);
  const loadEnabled = enabled && versionAtLeast(auth.backendVersion, "v0.86.179");
  useEffect(() => {
    if (!visit || !loadEnabled) {
      observer?.discard();
      return;
    }
    const finish = observer?.claim(visit);
    if (!finish) return;
    // The next frame after the committed route has had a paint opportunity.
    // This intentionally does not wait for independent API widgets to finish.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const elapsed = finish();
        if (elapsed !== undefined) visit.recordPageLoad(elapsed);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [visit, loadEnabled, observer]);
  const legacyAllowed = auth.legacyFallback && feature?.fallbackEnabled && effective?.status !== "retired";
  return (
    <LegacyObservationContext.Provider value={legacyAllowed ? visit?.recordLegacyOpen : undefined}>
      {children}
    </LegacyObservationContext.Provider>
  );
}
