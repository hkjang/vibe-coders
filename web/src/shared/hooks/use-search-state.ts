import { useCallback } from "react";
import { useSearchParams } from "react-router";

import { containsPotentialSecret } from "@/shared/security/secrets";

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
  const update = useCallback(
    (updates: SearchUpdates, options: { replace?: boolean; state?: unknown } = {}): void => {
      const next = new URLSearchParams(searchParams);
      for (const [key, raw] of Object.entries(updates)) {
        const value = raw === undefined || raw === null ? "" : String(raw);
        if (value === "" || containsPotentialSecret(value)) next.delete(key);
        else next.set(key, value);
      }
      setSearchParams(next, { replace: options.replace ?? true, state: options.state });
    },
    [searchParams, setSearchParams],
  );
  return [searchParams, update];
}

/** Positive integer page number from a query value; anything else is page 1. */
export function pageFromParam(value: string | null): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}
