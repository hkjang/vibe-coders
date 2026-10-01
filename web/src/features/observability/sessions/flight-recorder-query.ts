import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { apiClient } from "@/shared/api/client";
import type { FlightRecorderResponse } from "@/shared/api/domains/observability.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import type { SessionListAccess } from "./session-list-access";

/** The caller keys this component lifetime by the actual target and access key. */
export function useFlightRecorder(sessionId: string, access: SessionListAccess) {
  const client = useQueryClient();
  const lifetime = useId();
  const key = useMemo(
    () => ["observability", "sessions", "flight-recorder", access.key, sessionId, lifetime],
    [access.key, sessionId, lifetime],
  );
  const active = useRef(false);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const assertCurrent = (signal?: AbortSignal) => {
    access.assertRead();
    if (!active.current || signal?.aborted || sessionId === "")
      throw new AppError("비행기록 조회가 취소되었습니다.", { kind: "aborted" });
  };
  const query = useQuery({
    queryKey: key,
    enabled: access.readable && sessionId !== "",
    retry: false,
    refetchOnWindowFocus: false,
    gcTime: 0,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      assertCurrent(signal);
      const response = await apiClient.request(
        withPathParams(endpoints.domains.observability.sessions.flightRecorder, { session_id: sessionId }),
        { signal, routeId: "observability.sessions.flight-recorder" },
      );
      assertCurrent(signal);
      // session_id is a server-projected display value, not the request binding.
      return response;
    },
  });
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: key, exact: true });
      client.removeQueries({ queryKey: key, exact: true });
    },
    [client, key],
  );
  const subscribe = useCallback((notify: () => void) => client.getQueryCache().subscribe(notify), [client]);
  const snapshot = useCallback(() => client.getQueryState<FlightRecorderResponse>(key), [client, key]);
  const state = useSyncExternalStore(subscribe, snapshot);
  const observedQuery = client.getQueryCache().find({ queryKey: key, exact: true });
  const data = query.data;
  const count = state?.dataUpdateCount;
  const ready = Boolean(
    data &&
    access.readable &&
    state?.status === "success" &&
    state.fetchStatus === "idle" &&
    !state.isInvalidated &&
    state.data === data,
  );
  const canExport = () => {
    try {
      assertCurrent();
      const current = client.getQueryState<FlightRecorderResponse>(key);
      return (
        ready &&
        client.getQueryCache().find({ queryKey: key, exact: true }) === observedQuery &&
        current?.status === "success" &&
        current.fetchStatus === "idle" &&
        !current.isInvalidated &&
        current.data === data &&
        current.dataUpdateCount === count
      );
    } catch {
      return false;
    }
  };
  const refresh = () => {
    try {
      assertCurrent();
      if (client.getQueryState(key)?.fetchStatus !== "idle") return;
      void query.refetch({ cancelRefetch: false });
    } catch {
      // Disposed/currently unauthorized callbacks do not restart a query.
    }
  };
  return { query, refresh, ready, canExport };
}
