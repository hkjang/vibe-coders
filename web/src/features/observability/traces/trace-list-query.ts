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
import type { TraceSafeFlowAccess } from "./trace-safe-flow-access";

interface TraceListFrame {
  response: AppRequestsResponse;
  criteria: AppRequestsQuery;
  serial: number;
}

/** Trace keeps an open detail during a same-criteria refresh; new selections need a current list. */
export function useTraceListQuery(
  query: AppRequestsQuery,
  criteriaIdentity: string,
  selectionIdentity: string,
  access: TraceSafeFlowAccess,
  interval: number | false,
) {
  const client = useQueryClient();
  const mountId = useId();
  const [life, setLife] = useState({ criteriaIdentity, selectionIdentity, serial: 0 });
  if (life.criteriaIdentity !== criteriaIdentity || life.selectionIdentity !== selectionIdentity) {
    setLife({
      criteriaIdentity,
      selectionIdentity,
      serial: life.serial + (life.criteriaIdentity !== criteriaIdentity ? 1 : 0),
    });
  }
  const serial = life.serial;
  const key = useMemo(
    () => ["admin", "requests", "trace-explorer", access.key, mountId, serial],
    [access.key, mountId, serial],
  );
  const mounted = useRef(false);
  const latest = useRef(life);
  const retired = useRef<typeof life | undefined>(undefined);
  useLayoutEffect(() => {
    latest.current = life;
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const assertCriteria = () => {
    access.assertRead();
    if (
      !mounted.current ||
      latest.current.criteriaIdentity !== criteriaIdentity ||
      latest.current.serial !== serial
    )
      throw new AppError("현재 조회 기준의 목록을 다시 확인하세요.", { kind: "aborted" });
  };
  const result = useQuery({
    queryKey: key,
    enabled: access.readable,
    queryFn: async ({ signal }): Promise<TraceListFrame> => {
      assertCriteria();
      if (signal.aborted) throw new AppError("목록 조회가 취소되었습니다.", { kind: "aborted" });
      const criteria = { ...query };
      const response = await apiClient.request(endpoints.admin.requests, {
        headers: appRequestsContractHeaders,
        query: criteria,
        signal,
        routeId: "observability.traces",
      });
      assertCriteria();
      if (signal.aborted) throw new AppError("목록 조회가 취소되었습니다.", { kind: "aborted" });
      return { response, criteria, serial };
    },
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[3] === access.key ? previous : undefined,
    staleTime: 10_000,
    gcTime: 0,
    refetchInterval: (state) => (state.state.status === "error" && !state.state.data ? false : interval),
    refetchIntervalInBackground: false,
  });
  const cache = client.getQueryCache();
  const parent = cache.find<TraceListFrame>({ queryKey: key, exact: true });
  const queryHash = parent?.queryHash;
  const subscribe = useCallback(
    (notify: () => void) =>
      cache.subscribe((event) => {
        if (event.query.queryHash === queryHash) notify();
      }),
    [cache, queryHash],
  );
  const snapshot = useCallback(() => client.getQueryState<TraceListFrame>(key), [client, key]);
  // Observer timestamps and structurally shared data can both stay identical on success.
  // The actual Query state also exposes invalidation and its monotonic success count.
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const belongsToCriteria = result.data?.serial === serial;
  const ready =
    access.readable &&
    belongsToCriteria &&
    result.isSuccess &&
    !result.isPlaceholderData &&
    state?.status === "success" &&
    state.fetchStatus === "idle" &&
    !state.isInvalidated &&
    state.data === result.data;
  const assertCurrent = () => {
    assertCriteria();
    const current = cache.find<TraceListFrame>({ queryKey: key, exact: true });
    if (
      !ready ||
      !parent ||
      current !== parent ||
      current.state.status !== "success" ||
      current.state.fetchStatus !== "idle" ||
      current.state.isInvalidated ||
      current.state.data !== result.data ||
      current.state.dataUpdateCount !== state?.dataUpdateCount
    )
      throw new AppError("현재 목록을 다시 확인하세요.", { kind: "aborted" });
  };
  const assertSelectionLife = () => {
    assertCriteria();
    if (latest.current !== life || retired.current === life)
      throw new AppError("현재 요청을 다시 선택하세요.", { kind: "aborted" });
  };
  const assertRow = (request: AppRequestSummary) => {
    assertCurrent();
    assertSelectionLife();
    if (
      result.data?.response.request_contract_version !== 2 ||
      !result.data.response.requests.includes(request)
    )
      throw new AppError("현재 목록에서 요청을 다시 선택하세요.", { kind: "aborted" });
  };
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: key, exact: true });
    },
    [client, key],
  );

  return {
    result,
    ready,
    belongsToCriteria,
    revision: state?.dataUpdateCount ?? 0,
    assertCurrent,
    assertSelected: (request: AppRequestSummary) => {
      assertRow(request);
      if (!selectionIdentity) throw new AppError("현재 요청을 다시 선택하세요.", { kind: "aborted" });
    },
    canSelect: (request: AppRequestSummary) => {
      try {
        assertRow(request);
        return true;
      } catch {
        return false;
      }
    },
    retireSelection: () => {
      try {
        assertSelectionLife();
      } catch {
        return false;
      }
      // Close/switch callbacks must retire immediately, before Router/React commits.
      retired.current = life;
      return true;
    },
  };
}
