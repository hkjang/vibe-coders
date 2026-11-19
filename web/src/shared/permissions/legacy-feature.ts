import type { AuthContextValue } from "@/app/auth/AuthProvider";
import { resolveFeature } from "@/config/migration-registry";
import { canOpenLegacyAdmin } from "./legacy-admin";

type LegacyFeatureAccess = Pick<
  AuthContextValue,
  "mode" | "authenticationMode" | "legacyFallback" | "user" | "features" | "backendVersion"
>;

/** Presentation only: the destination's policy never grants access to Legacy APIs. */
export function canOpenLegacyFeature(auth: LegacyFeatureAccess, featureId: string): boolean {
  if (
    !["authenticated", "legacy", "open"].includes(auth.mode) ||
    !canOpenLegacyAdmin(auth) ||
    !Array.isArray(auth.features) ||
    typeof auth.backendVersion !== "string"
  )
    return false;
  const feature = auth.features.find((item) => item.featureId === featureId);
  if (
    !feature ||
    !feature.fallbackEnabled ||
    !feature.legacyPath ||
    feature.status === "hidden" ||
    feature.status === "retired" ||
    (auth.user && feature.requiredPermission && !auth.user.scopes.includes(feature.requiredPermission))
  )
    return false;
  const effective = resolveFeature(feature, auth.user, auth.backendVersion, {
    legacyFallback: auth.legacyFallback,
  });
  return effective.permitted && effective.status !== "hidden" && effective.status !== "retired";
}
