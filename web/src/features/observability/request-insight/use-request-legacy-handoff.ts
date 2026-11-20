import { useAuth } from "@/app/auth/AuthProvider";
import { legacyRequestHandoff, type RequestLegacyListContext } from "@/config/legacy-request-handoff";
import { resolveLegacyFeatureHref } from "@/shared/permissions/legacy-feature";

export type RequestLegacyFeature = "observability.io" | "observability.requests";

export function useRequestLegacyHandoff(
  requestId: string,
  featureId: RequestLegacyFeature,
  list?: RequestLegacyListContext,
) {
  const auth = useAuth();
  const base = auth.features.find((feature) => feature.featureId === featureId)?.legacyPath;
  return legacyRequestHandoff({
    base: resolveLegacyFeatureHref(auth, featureId, base),
    requestId,
    detailSupported: auth.capabilities?.legacy_request_detail === true,
    extendedSupported: auth.capabilities?.legacy_request_direct_detail === true,
    filtersSupported: auth.capabilities?.legacy_request_filters === true,
    prefixes: auth.credentialPrefixes,
    ...(list ? { list } : {}),
  });
}
