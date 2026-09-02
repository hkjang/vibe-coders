import { Navigate, Outlet, useLocation } from "react-router";

import {
  isSanitizedAppLocationState,
  locationStateWithSensitiveRejections,
  sanitizeAppRouteHash,
  sanitizeAppRouteSearch,
} from "@/shared/security/app-route-query";

export function RouteQueryGuard(): React.JSX.Element {
  const location = useLocation();
  const result = sanitizeAppRouteSearch(location.pathname, location.search);
  const hash = sanitizeAppRouteHash(location.hash, location.pathname);
  const state = locationStateWithSensitiveRejections(location.state, result.sensitiveKeys);
  if (
    result.search !== location.search ||
    hash !== location.hash ||
    !isSanitizedAppLocationState(location.state, state)
  ) {
    return (
      <Navigate replace state={state} to={{ pathname: location.pathname, search: result.search, hash }} />
    );
  }
  return <Outlet />;
}
