import { useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { apiClient } from "@/shared/api/client";
import type { KillSwitchState } from "@/shared/api/domains/governance";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { killSwitchMessages } from "./kill-switch-messages";

export const killSwitchReviewError = () =>
  new AppError(killSwitchMessages.reviewInvalid, { kind: "aborted" });

export const killSwitchQueryKey = ["governance", "kill-switch"] as const;
export interface KillSwitchSnapshot {
  query: Query<KillSwitchState>;
  revision: number;
  data: KillSwitchState;
}

export function useKillSwitchState(owner: string) {
  const client = useQueryClient();
  const nonce = useId();
  const key = useMemo(() => [...killSwitchQueryKey, owner, nonce], [owner, nonce]);
  const incidentKey = useMemo(() => ["governance", "incidents", "7d", owner, nonce], [owner, nonce]);
  const live = useRef(false);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      for (const queryKey of [key, incidentKey]) {
        void client.cancelQueries({ queryKey, exact: true });
        client.removeQueries({ queryKey, exact: true });
      }
    };
  }, [client, key, incidentKey]);
  const revision = useRef(0);
  const subscribe = useCallback(
    (notify: () => void) =>
      client.getQueryCache().subscribe((event) => {
        if (
          ["updated", "removed", "added"].includes(event.type) &&
          event.query.queryKey.length === key.length &&
          event.query.queryKey.every((part: unknown, index: number) => part === key[index])
        ) {
          revision.current += 1;
          notify();
        }
      }),
    [client, key],
  );
  const observedRevision = useSyncExternalStore(subscribe, () => revision.current);
  const result = useQuery({
    queryKey: key,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      if (!live.current || signal.aborted) throw killSwitchReviewError();
      const result = await apiClient.request(endpoints.domains.governance.killSwitch.get, {
        signal,
        routeId: "governance.policies",
      });
      if (!live.current || signal.aborted) throw killSwitchReviewError();
      return result;
    },
  });
  const current = () => client.getQueryCache().find<KillSwitchState>({ queryKey: key, exact: true });
  const ready = result.isSuccess && !result.isFetching && current()?.state.isInvalidated === false;
  const assertState = (snapshot?: KillSwitchSnapshot) => {
    const query = current();
    if (
      !live.current ||
      !query ||
      query.state.status !== "success" ||
      query.state.fetchStatus !== "idle" ||
      query.state.isInvalidated ||
      !query.state.data ||
      (snapshot &&
        (query !== snapshot.query ||
          revision.current !== snapshot.revision ||
          query.state.data !== snapshot.data))
    )
      throw killSwitchReviewError();
    return query;
  };
  const capture = (): KillSwitchSnapshot => {
    const query = assertState();
    if (!result.data || !ready || revision.current !== observedRevision || query.state.data !== result.data)
      throw killSwitchReviewError();
    return { query, revision: observedRevision, data: result.data };
  };
  const matches = (snapshot: KillSwitchSnapshot) =>
    ready &&
    current() === snapshot.query &&
    observedRevision === snapshot.revision &&
    result.data === snapshot.data;
  return { result, ready, capture, assertState, matches, key, incidentKey };
}
