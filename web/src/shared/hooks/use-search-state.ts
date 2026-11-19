import { useCallback, useContext } from "react";
import { useHref, useLocation, useSearchParams } from "react-router";
import { SearchLocationContext } from "./search-location";

import { useAuth } from "@/app/auth/AuthProvider";
import {
  locationStateWithSensitiveRejections,
  sanitizeAppRouteSearch,
} from "@/shared/security/app-route-query";

export type SearchUpdates = Readonly<Record<string, string | number | undefined | null>>;

/**
 * Read and update URL query state. Empty values remove the key; values that look
 * like credentials are never written, so a pasted key cannot land in history.
 * Returns `[params, update]` where `update` replaces history by default.
 */
export function useSearchState(): [
  URLSearchParams,
  (updates: SearchUpdates, options?: { replace?: boolean; state?: unknown }) => void,
] {
  const [searchParams, setSearchParams] = useSearchParams();
  const { pathname } = useLocation();
  const routePath = useHref({ pathname });
  const readLocation = useContext(SearchLocationContext);
  const { credentialPrefixes } = useAuth();
  const update = useCallback(
    (updates: SearchUpdates, options: { replace?: boolean; state?: unknown } = {}): void => {
      // React may still show the previous location after navigation updates the
      // router. Compose against its event-time location so adjacent controls do
      // not overwrite each other. A control from a departed route cannot write.
      const current = readLocation?.();
      if (current && current.pathname !== routePath) return;
      const next = new URLSearchParams(current?.search ?? searchParams);
      for (const [key, raw] of Object.entries(updates)) {
        const value = raw === undefined || raw === null ? "" : String(raw);
        if (value === "") next.delete(key);
        else next.set(key, value);
      }
      // Apply the same route policy BEFORE history changes, including untouched
      // parameters. RouteQueryGuard remains the boundary for inbound links.
      const safe = sanitizeAppRouteSearch(pathname, next.toString(), credentialPrefixes);
      setSearchParams(safe.search, {
        replace: options.replace ?? true,
        state: locationStateWithSensitiveRejections(options.state, safe.sensitiveKeys),
      });
    },
    [searchParams, setSearchParams, pathname, routePath, readLocation, credentialPrefixes],
  );
  return [searchParams, update];
}

/** Positive integer page number from a query value; anything else is page 1. */
export function pageFromParam(value: string | null): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}
