import { Navigate, useLocation } from "react-router";

type GatewayCatalogPath = "/gateway/providers" | "/gateway/models";

function compatibilityRedirectTarget(
  target: GatewayCatalogPath,
  location: Pick<Location, "hash" | "search">,
): string {
  return `${target}${location.search}${location.hash}`;
}

export function CompatibilityRedirect({ to }: { to: GatewayCatalogPath }): React.JSX.Element {
  const location = useLocation();
  return <Navigate replace to={compatibilityRedirectTarget(to, location)} />;
}
