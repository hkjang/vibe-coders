import { useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { apiClient } from "@/shared/api/client";
import type { Text2SQLEmergencyState } from "@/shared/api/domains/text2sql";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";

export const emergencyReviewError = () =>
  new AppError("조회 기준이 바뀌었습니다. 취소 후 상태를 다시 확인하세요.", { kind: "aborted" });

export interface Text2SQLEmergencySnapshot {
  query: Query<Text2SQLEmergencyState>;
  revision: number;
  data: Text2SQLEmergencyState;
}

export function useText2SQLEmergencyState(owner: string) {
  const client = useQueryClient();
  const nonce = useId();
  const key = useMemo(() => ["text2sql", "kill-switch", owner, nonce], [owner, nonce]);
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
      const data = await apiClient.request(endpoints.domains.text2sql.killSwitch.read, {
        signal,
        routeId: "text2sql.overview",
      });
      if (!live.current || signal.aborted) throw emergencyReviewError();
      return data;
    },
  });
  const current = () => client.getQueryCache().find<Text2SQLEmergencyState>({ queryKey: key, exact: true });
  const ready = result.isSuccess && !result.isFetching && current()?.state.isInvalidated === false;
  const supported = (data: Text2SQLEmergencyState) =>
    data.scope === "responding_process" &&
    Boolean(data.instance_ref && data.review_token && data.observed_at) &&
    typeof data.config_enabled === "boolean";
  const assertState = (snapshot?: Text2SQLEmergencySnapshot) => {
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
  const capture = (): Text2SQLEmergencySnapshot => {
    const query = assertState();
    if (!result.data || !ready || observedRevision !== revision.current || query.state.data !== result.data)
      throw emergencyReviewError();
    return { query, revision: observedRevision, data: result.data };
  };
  const matches = (snapshot: Text2SQLEmergencySnapshot) =>
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
