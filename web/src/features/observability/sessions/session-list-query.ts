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
import type { SessionSummary } from "@/shared/api/domains/observability.schemas";
import type { SessionListAccess } from "./session-list-access";
import { filterSessionRows, sessionResponseDays, type SessionListResult } from "./session-list-state";

export function useSessionList(
  days: number,
  keyword: string,
  identity: string,
  access: SessionListAccess,
  interval: number | false,
) {
  const client = useQueryClient();
  const lifetime = useId();
  const prefix = useMemo(() => ["observability", "sessions", access.key, lifetime], [access.key, lifetime]);
  // Period caches remain usable. A separate monotonic filter serial retires
  // old days/q callbacks even when A → B → A returns to the identical data.
  const key = useMemo(() => [...prefix, days], [prefix, days]);
  const [filter, setFilter] = useState({ identity, serial: 0 });
  if (filter.identity !== identity) setFilter({ identity, serial: filter.serial + 1 });
  const [queryLife, setQueryLife] = useState({ days, serial: 0 });
  if (queryLife.days !== days) setQueryLife({ days, serial: queryLife.serial + 1 });
  const filterSerial = filter.serial;
  const querySerial = queryLife.serial;
  const mounted = useRef(false);
  const latest = useRef({ filterSerial, querySerial });
  const generation = useRef(0);
  useLayoutEffect(() => {
    latest.current = { filterSerial, querySerial };
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const assertQuery = (signal?: AbortSignal) => {
    access.assertRead();
    if (!mounted.current || signal?.aborted || latest.current.querySerial !== querySerial)
      throw new AppError("세션 목록 조회가 취소되었습니다.", { kind: "aborted" });
  };
  const result = useQuery({
    queryKey: key,
    enabled: access.readable,
    queryFn: async ({ signal }): Promise<SessionListResult> => {
      assertQuery(signal);
      const response = await apiClient.request(endpoints.domains.observability.sessions.list, {
        query: { days },
        signal,
        routeId: "observability.sessions",
      });
      assertQuery(signal);
      return { response, requestedDays: days, generation: ++generation.current };
    },
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === access.key && previousQuery.queryKey[3] === lifetime
        ? previous
        : undefined,
    staleTime: 15_000,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: key, exact: true });
    },
    [client, key],
  );
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: prefix });
      client.removeQueries({ queryKey: prefix });
    },
    [client, prefix],
  );
  const subscribe = useCallback((notify: () => void) => client.getQueryCache().subscribe(notify), [client]);
  const snapshot = useCallback(() => client.getQueryState(key)?.dataUpdateCount ?? 0, [client, key]);
  // Same-object setData success under a frozen clock must create new callbacks too.
  const successCount = useSyncExternalStore(subscribe, snapshot);
  const rows = useMemo(() => filterSessionRows(result.data?.response, keyword), [result.data, keyword]);
  const assertFilter = () => {
    assertQuery();
    if (latest.current.filterSerial !== filterSerial)
      throw new AppError("현재 세션 목록을 확인하세요.", { kind: "aborted" });
  };
  const ready =
    result.isSuccess &&
    !result.isPlaceholderData &&
    !result.isFetching &&
    sessionResponseDays(result.data) === days;
  const canOpen = (row: SessionSummary) => {
    try {
      assertFilter();
      const current = client.getQueryState<SessionListResult>(key);
      return (
        ready &&
        current?.status === "success" &&
        current.fetchStatus === "idle" &&
        !current.isInvalidated &&
        current.data === result.data &&
        current.dataUpdateCount === successCount &&
        rows.includes(row)
      );
    } catch {
      return false;
    }
  };
  const refresh = () => {
    try {
      assertFilter();
      if (client.getQueryState(key)?.fetchStatus === "fetching") return;
      void result.refetch();
    } catch {
      /* Disposed callbacks do not restart a query. */
    }
  };
  return { result, rows, canOpen, refresh, filterSerial, successCount, ready };
}
