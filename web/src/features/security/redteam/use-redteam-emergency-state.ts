import { useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { apiClient } from "@/shared/api/client";
import type { RedTeamEmergencyState } from "@/shared/api/domains/redteam";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";

export const emergencyReviewError = () =>
  new AppError("조회 기준이 바뀌었습니다. 취소 후 상태를 다시 확인하세요.", { kind: "aborted" });

export interface RedTeamEmergencySnapshot {
  query: Query<RedTeamEmergencyState>;
  revision: number;
  data: RedTeamEmergencyState;
}

export function useRedTeamEmergencyState(owner: string) {
  const client = useQueryClient();
  const nonce = useId();
  const key = useMemo(() => ["redteam", "kill-switch", owner, nonce], [owner, nonce]);
  const live = useRef(false);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      void client.cancelQueries({ queryKey: key, exact: true });
      client.removeQueries({ queryKey: key, exact: true });
    };
  }, [client, key]);
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
      if (!live.current || signal.aborted) throw emergencyReviewError();
      const data = await apiClient.request(endpoints.domains.redteam.killSwitch.read, {
        signal,
        routeId: "security.redteam",
      });
      if (!live.current || signal.aborted) throw emergencyReviewError();
      return data;
    },
  });
  const current = () => client.getQueryCache().find<RedTeamEmergencyState>({ queryKey: key, exact: true });
  const ready = result.isSuccess && !result.isFetching && current()?.state.isInvalidated === false;
  const supported = (data: RedTeamEmergencyState) =>
    data.scope === "responding_process" &&
    Boolean(data.instance_ref && data.review_token && data.observed_at);
  const assertState = (snapshot?: RedTeamEmergencySnapshot) => {
    const query = current();
    if (
      !live.current ||
      !query ||
      query.state.status !== "success" ||
      query.state.fetchStatus !== "idle" ||
      query.state.isInvalidated ||
      !query.state.data ||
      !supported(query.state.data) ||
      (snapshot &&
        (query !== snapshot.query ||
          revision.current !== snapshot.revision ||
          query.state.data !== snapshot.data))
    )
      throw emergencyReviewError();
    return query;
  };
  const capture = (): RedTeamEmergencySnapshot => {
    const query = assertState();
    if (!result.data || !ready || observedRevision !== revision.current || query.state.data !== result.data)
      throw emergencyReviewError();
    return { query, revision: observedRevision, data: result.data };
  };
  const matches = (snapshot: RedTeamEmergencySnapshot) =>
    ready &&
    current() === snapshot.query &&
    observedRevision === snapshot.revision &&
    result.data === snapshot.data;
  return {
    result,
    ready,
    supported: Boolean(result.data && supported(result.data)),
    capture,
    assertState,
    matches,
    key,
  };
}
