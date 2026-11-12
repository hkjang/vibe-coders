import { useAuth } from "@/app/auth/AuthProvider";
import { featurePath, resolveFeature } from "@/config/migration-registry";
import { legacySubroutes } from "@/config/legacy-route-map";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { isValidRequestQueryField } from "@/shared/utils/request-query-filters";
import { validIpIdentity, validIpText } from "./ip-usage-model";

export function useIpLinks() {
  const auth = useAuth();
  const feature = auth.features.find((feature) => feature.featureId === "observability.requests");
  const resolved =
    feature &&
    resolveFeature(feature, auth.user, auth.backendVersion, { legacyFallback: auth.legacyFallback });
  const canExplore =
    resolved?.permitted &&
    resolved.status !== "hidden" &&
    resolved.status !== "legacy" &&
    (auth.mode === "open" || auth.mode === "legacy" || auth.user?.scopes.includes("observability:read"));
  const accessFeature = auth.features.find((feature) => feature.featureId === "access.users");
  const legacy = canOpenLegacyAdmin(auth) && accessFeature?.fallbackEnabled;
  return {
    legacyHref: (ip?: string) =>
      legacy
        ? legacySubroutes["access.ips"] +
          (ip && validIpIdentity(ip, auth.credentialPrefixes) ? "/" + encodeURIComponent(ip) : "")
        : undefined,
    requestHref: (ip: string, id?: string) => {
      if (!feature || !canExplore || !validIpIdentity(ip, auth.credentialPrefixes)) return undefined;
      if (
        id &&
        (!validIpText(id, auth.credentialPrefixes, 512) || !isValidRequestQueryField("request_id", id))
      )
        return undefined;
      const params = new URLSearchParams({ ip });
      if (id) params.set("request_id", id);
      return featurePath(feature) + "?" + params.toString();
    },
  };
}
