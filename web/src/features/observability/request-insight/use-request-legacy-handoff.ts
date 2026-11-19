import { useAuth } from "@/app/auth/AuthProvider";
import { legacyDirectRequestDestination } from "@/config/legacy-request-map";

export type RequestLegacyFeature = "observability.io" | "observability.requests";

export function useRequestLegacyHandoff(requestId: string, featureId: RequestLegacyFeature) {
  const auth = useAuth();
  return legacyDirectRequestDestination(
    auth.features.find((feature) => feature.featureId === featureId)?.legacyPath,
    requestId,
    auth.capabilities?.legacy_request_detail === true,
    auth.capabilities?.legacy_request_direct_detail === true,
    auth.credentialPrefixes,
  );
}
