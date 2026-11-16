import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { appRequestsContractHeaders } from "@/shared/api/app-request-contract";
import type { AppRequestSummary, AppRequestsQuery, AppRequestsResponse } from "@/shared/api/schemas";
import type { TraceSafeFlowAccess } from "../traces/trace-safe-flow-access";
import { useTraceReadScope } from "../traces/trace-read-scope";
import { featureOwnedKey } from "@/shared/hooks/use-feature-read-owner";

export const requestSelectionIdentity = (request: AppRequestSummary) =>
  JSON.stringify([request.request_ref, request.created_at]);

export function useRequestSafeFlowSelection(
  query: AppRequestsQuery,
  access: TraceSafeFlowAccess,
  interval: number | false,
  pauseRefresh = false,
) {
  const client = useQueryClient();
  const scope = useTraceReadScope(access, "request-list-read");
  const owner = scope.owner;
  const denied = owner.denied;
  const lifetime = useId();
  const generation = useRef(0);
  const selectionSerial = useRef(0);
  const identity = JSON.stringify(query);
  const [queryLife, setQueryLife] = useState({ identity, serial: 0 });
  if (queryLife.identity !== identity) setQueryLife({ identity, serial: queryLife.serial + 1 });
  const serial = queryLife.serial;
  const key = useMemo(
    () =>
      featureOwnedKey(["admin", "requests", "request-explorer", access.key, lifetime, serial, query], owner),
    [access.key, lifetime, serial, query, owner],
  );
  const [selected, setSelected] = useState<{
    identity: string;
    generation: number;
    serial: number;
    ordinal: number;
    request: AppRequestSummary;
  }>();
  const mounted = useRef(false);
  const latest = useRef({ identity, selected, serial });
  const result = useQuery({
    queryKey: key,
    enabled: access.readable && owner.readable && !owner.denied,
    retry: false,
    queryFn: async ({ signal }) => {
      scope.assertCurrent(signal);
      if (
        !mounted.current ||
        signal.aborted ||
        latest.current.serial !== serial ||
        latest.current.identity !== identity
      )
        throw new AppError("목록 조회가 취소되었습니다.", { kind: "aborted" });
      let response: AppRequestsResponse;
      try {
        response = await apiClient.request(endpoints.admin.requests, {
          headers: appRequestsContractHeaders,
          query,
          signal,
          routeId: "observability.requests",
        });
      } catch (error) {
        scope.assertCurrent(signal);
        scope.captureDenial(error);
        throw error;
      }
      scope.assertCurrent(signal);
      if (
        !mounted.current ||
        signal.aborted ||
        latest.current.serial !== serial ||
        latest.current.identity !== identity
      )
        throw new AppError("목록 조회가 취소되었습니다.", { kind: "aborted" });
      // A successful response is a new generation, even under a frozen clock or
      // TanStack structural sharing of byte-identical metadata.
      return { response, generation: ++generation.current };
    },
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[3] === access.key &&
      previousQuery.queryKey.at(-2) === owner.marker &&
      previousQuery.queryKey.at(-1) === owner.id &&
      !owner.denied
        ? previous
        : undefined,
    staleTime: 10_000,
    gcTime: 0,
    refetchInterval: (state) =>
      pauseRefresh || selected || (state.state.status === "error" && !state.state.data) ? false : interval,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: !pauseRefresh,
    refetchOnReconnect: !pauseRefresh,
  });
  const validSelection =
    !owner.denied && selected?.identity === identity && selected.generation === result.data?.generation;
  // Retirement is permanent: returning to a cached filter cannot revive a dialog.
  if (selected && !validSelection) setSelected(undefined);
  const activeSelected = validSelection ? selected : undefined;
  useLayoutEffect(() => {
    latest.current = { identity, selected: activeSelected, serial };
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: key, exact: true });
    },
    [client, key],
  );
  const cache = client.getQueryCache();
  const parent = cache.find({ queryKey: key, exact: true });
  const queryHash = parent?.queryHash;
  const subscribe = useCallback(
    (notify: () => void) =>
      cache.subscribe((event) => {
        if (event.query.queryHash === queryHash) notify();
      }),
    [cache, queryHash],
  );
  const snapshot = useCallback(() => client.getQueryState(key), [client, key]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const frame = useMemo(
    () => ({ parent, revision: state?.dataUpdateCount, serial, owner, data: result.data }),
    [parent, state?.dataUpdateCount, serial, owner, result.data],
  );
  const ready =
    access.readable &&
    !owner.denied &&
    result.isSuccess &&
    !result.isFetching &&
    !result.isPlaceholderData &&
    state?.status === "success" &&
    state.fetchStatus === "idle" &&
    !state.isInvalidated;
  const assertReady = () => {
    scope.assertCurrent();
    const entry = cache.find({ queryKey: key, exact: true });
    const current = entry?.state;
    if (
      !mounted.current ||
      latest.current.identity !== identity ||
      latest.current.serial !== serial ||
      !ready ||
      !parent ||
      entry !== parent ||
      current?.status !== "success" ||
      current.fetchStatus !== "idle" ||
      current.isInvalidated ||
      current.data !== result.data ||
      current.dataUpdateCount !== state?.dataUpdateCount
    )
      throw new AppError("현재 목록을 다시 확인하세요.", { kind: "aborted" });
  };
  const open = (request: AppRequestSummary, ordinal: number) => {
    try {
      assertReady();
    } catch {
      return false;
    }
    if (!result.data?.response.requests.includes(request)) return false;
    latest.current.selected = undefined;
    setSelected({
      identity,
      generation: result.data.generation,
      serial: ++selectionSerial.current,
      ordinal,
      request,
    });
    return true;
  };
  const assertSelected = () => {
    assertReady();
    if (!activeSelected || latest.current.selected !== activeSelected)
      throw new AppError("현재 요청을 다시 선택하세요.", { kind: "aborted" });
  };
  return {
    result,
    selected: activeSelected,
    ready,
    frame,
    denied,
    denialRequestId: scope.requestId,
    isDataCurrent: () => {
      try {
        assertReady();
        return true;
      } catch {
        return false;
      }
    },
    refresh: () => {
      if (!mounted.current || latest.current.identity !== identity || latest.current.serial !== serial)
        return;
      if (denied) {
        scope.restart();
        return;
      }
      try {
        scope.assertCurrent();
        if (client.getQueryState(key)?.fetchStatus !== "fetching")
          void result.refetch({ cancelRefetch: false });
      } catch {
        /* Retired callbacks cannot start another read. */
      }
    },
    open,
    assertSelected,
    close: () => {
      latest.current.selected = undefined;
      setSelected(undefined);
    },
  };
}
