import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { Policy } from "@/shared/api/domains/governance";
import { fingerprint } from "./policy-editor-security";

/** All policy readers and write completions share only their current principal/session. */
export const policyCatalogKey = (session: string) => ["governance", "policies", session] as const;

export function policyCatalogCurrent(client: QueryClient, key: QueryKey, baseline: Policy): boolean {
  const state = client.getQueryState(key);
  const data = client.getQueryData<{ policies?: Policy[] | null }>(key);
  const rows = data?.policies?.filter((row) => row.id === baseline.id);
  return (
    state?.status === "success" &&
    !state.isInvalidated &&
    state.fetchStatus === "idle" &&
    rows?.length === 1 &&
    fingerprint(rows[0]) === fingerprint(baseline)
  );
}
