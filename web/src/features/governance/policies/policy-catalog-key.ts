import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { Policy } from "@/shared/api/domains/governance";
import { fingerprint } from "./policy-editor-security";

/** All policy readers and write completions share only their current principal/session. */
export const policyCatalogKey = (session: string) => ["governance", "policies", session] as const;
export const policyAdviceKey = (session: string, window: string) =>
  ["governance", "advisor", window, session] as const;

export function policyCatalogCurrent(client: QueryClient, key: QueryKey, baseline: Policy): boolean {
  return catalogRecordCurrent(client, key, "policies", baseline);
}

export function catalogRecordCurrent<T extends { id: string }>(
  client: QueryClient,
  key: QueryKey,
  field: string,
  baseline: T,
  recordFingerprint: (row: T) => string = fingerprint,
): boolean {
  const state = client.getQueryState(key);
  const data = client.getQueryData<Record<string, T[] | null | undefined>>(key);
  const rows = data?.[field]?.filter((row) => row.id === baseline.id);
  return (
    state?.status === "success" &&
    !state.isInvalidated &&
    state.fetchStatus === "idle" &&
    rows?.length === 1 &&
    rows[0] !== undefined &&
    recordFingerprint(rows[0]) === recordFingerprint(baseline)
  );
}
