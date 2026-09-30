import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { apiClient } from "@/shared/api/client";
import type { RoutingRule } from "@/shared/api/domains/routing";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { routingRulesQueryKey } from "./routing-shared";
import type { RoutingToggleAccess } from "./routing-toggle-access";
import { toggleListReason } from "./routing-toggle-state";

type RuleList = { rules: RoutingRule[] };

/** Single RulesTab-owned observer; dialogs only inspect its confirmed cache. */
export function useRoutingToggleData(access: RoutingToggleAccess) {
  const client = useQueryClient();
  const key = [...routingRulesQueryKey, access.epoch, access.owner] as const;
  const query = useQuery({
    queryKey: key,
    enabled: access.readAllowed,
    retry: false,
    queryFn: async ({ signal }) => {
      access.assertRead();
      const result = await apiClient.request(endpoints.domains.routing.rules.list, {
        signal,
        routeId: "routing.rules",
      });
      access.assertRead();
      return result;
    },
  });
  const state = useSyncExternalStore(
    useCallback((notify) => client.getQueryCache().subscribe(notify), [client]),
    () => client.getQueryState<RuleList>(key),
  );
  // These are already-adapted rows. This does not certify the raw JSON schema:
  // the shared API currently has nullish/default coercion, unchanged here.
  const confirmed =
    state?.status === "success" &&
    state.fetchStatus === "idle" &&
    !state.isInvalidated &&
    !!state.data &&
    new Set(state.data.rules.map((row) => row.id)).size === state.data.rules.length;
  function assertConfirmed() {
    access.assertRead();
    const latest = client.getQueryState<RuleList>(key);
    if (
      latest?.status !== "success" ||
      latest.fetchStatus !== "idle" ||
      latest.isInvalidated ||
      !latest.data ||
      new Set(latest.data.rules.map((row) => row.id)).size !== latest.data.rules.length
    )
      throw new AppError(toggleListReason, { kind: "contract" });
    return latest.data.rules;
  }
  async function refresh() {
    access.assertRead();
    await query.refetch();
  }
  function afterCommit() {
    access.assertOwned();
    void client.invalidateQueries({ queryKey: routingRulesQueryKey, refetchType: "none" });
    try {
      access.assertRead();
      void refresh().catch(() => undefined);
    } catch {
      // No new GET after ownership/read permission is withdrawn. A committed
      // PATCH remains successful even if the following permitted GET fails.
    }
  }
  return { query, confirmed, assertConfirmed, refresh, afterCommit };
}
export type RoutingToggleData = ReturnType<typeof useRoutingToggleData>;
