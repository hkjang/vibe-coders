import { isLegacyAdminHref } from "@/config/legacy-route-map";
import { containsPotentialSecret } from "@/shared/security/secrets";
import type { AuthContextValue } from "@/app/auth/AuthProvider";
import { migrationRegistry, resolveFeature } from "@/config/migration-registry";
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

/** Compiled defaults follow the current target; explicit supported subroutes keep their own state. */
export function resolveLegacyFeatureHref(
  auth: LegacyFeatureAccess & Pick<AuthContextValue, "credentialPrefixes">,
  featureId: string,
  requestedHref: string | undefined,
): `/admin${string}` | undefined {
  if (!requestedHref || !canOpenLegacyFeature(auth, featureId)) return undefined;
  const target = auth.features.find((feature) => feature.featureId === featureId);
  if (
    !target ||
    !isLegacyAdminHref(target.legacyPath) ||
    containsPotentialSecret(target.legacyPath, auth.credentialPrefixes)
  )
    return undefined;
  const compiled = migrationRegistry.find((feature) => feature.featureId === featureId);
  const href = requestedHref === compiled?.legacyPath ? target.legacyPath : requestedHref;
  return isLegacyAdminHref(href) && !containsPotentialSecret(href, auth.credentialPrefixes)
    ? href
    : undefined;
}
