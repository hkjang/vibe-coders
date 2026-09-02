import { Navigate } from "react-router";

import { useAuth } from "@/app/auth/AuthProvider";
import { resolveDefaultEntry } from "@/app/router/default-entry";

export function DefaultEntryRedirect(): React.JSX.Element {
  const { defaultEntry, features, user, backendVersion, legacyFallback } = useAuth();
  return (
    <Navigate
      replace
      to={resolveDefaultEntry(defaultEntry, {
        features,
        user,
        backendVersion,
        legacyFallback,
      })}
    />
  );
}
