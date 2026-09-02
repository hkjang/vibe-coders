import { Navigate, useLocation } from "react-router";

import { sanitizeAppRouteHash, sanitizeAppRouteSearch } from "@/shared/security/app-route-query";

type GatewayCatalogPath = "/gateway/providers" | "/gateway/models";

function compatibilityRedirectTarget(
  target: GatewayCatalogPath,
  location: Pick<Location, "hash" | "search">,
): string {
  const search = sanitizeAppRouteSearch(target, location.search).search;
  const hash = sanitizeAppRouteHash(location.hash);
  return `${target}${search}${hash}`;
}

export function CompatibilityRedirect({ to }: { to: GatewayCatalogPath }): React.JSX.Element {
  const location = useLocation();
  return <Navigate replace to={compatibilityRedirectTarget(to, location)} />;
}
