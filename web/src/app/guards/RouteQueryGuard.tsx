import { Navigate, Outlet, useLocation } from "react-router";

import {
  locationStateWithSensitiveRejections,
  sanitizeAppRouteHash,
  sanitizeAppRouteSearch,
} from "@/shared/security/app-route-query";

export function RouteQueryGuard(): React.JSX.Element {
  const location = useLocation();
  const result = sanitizeAppRouteSearch(location.pathname, location.search);
  const hash = sanitizeAppRouteHash(location.hash);
  if (result.search !== location.search || hash !== location.hash) {
    return (
      <Navigate
        replace
        state={locationStateWithSensitiveRejections(location.state, result.sensitiveKeys)}
        to={{ pathname: location.pathname, search: result.search, hash }}
      />
    );
  }
  return <Outlet />;
}
