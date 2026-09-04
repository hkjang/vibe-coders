import { Navigate, Outlet, useLocation } from "react-router";

import { useAuth } from "@/app/auth/AuthProvider";
import {
  isSanitizedAppLocationState,
  locationStateWithSensitiveRejections,
  sanitizeAppRouteHash,
  sanitizeAppRouteSearch,
} from "@/shared/security/app-route-query";

export function RouteQueryGuard(): React.JSX.Element {
  const auth = useAuth();
  const location = useLocation();
  const result = sanitizeAppRouteSearch(location.pathname, location.search, auth.credentialPrefixes);
  const hash = sanitizeAppRouteHash(location.hash, location.pathname, auth.credentialPrefixes);
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
