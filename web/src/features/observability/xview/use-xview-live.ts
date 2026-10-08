import { notifyManager, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { apiClient } from "@/shared/api/client";
import type { ScatterQuery } from "@/shared/api/domains/observability";
import type { ScatterResponse } from "@/shared/api/domains/observability.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { AppError, isAppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { containsPotentialSecret } from "@/shared/security/secrets";
import type { XViewReadOwner } from "./xview-live-access";
import { startXViewPoller } from "./xview-live-poller";
import {
  maxLivePoints,
  mergeXViewPoints,
  updateXViewClock,
  type XViewBuffer,
  type XViewFilters,
} from "./xview-live-state";

export { liveIntervalMs, maxLivePoints } from "./xview-live-state";
export type { XViewFilters } from "./xview-live-state";

let nextLifetime = 0;
interface Receipt {
  report: ScatterResponse;
  buffer: XViewBuffer;
}
const empty: XViewBuffer = { points: [], truncated: false, lastUpdatedAt: 0, status: "waiting" };
export const xviewDeniedMessage =
  "로그인 상태 또는 XView 조회 권한을 확인할 수 없습니다. 이전 자료를 숨겼습니다. 필요하면 다시 로그인한 뒤 지금 새로고침을 눌러 주세요.";

/** Polling ownership stays inside the hook, never a key on the page or note editor. */
export function useXViewLive(filters: XViewFilters, live: boolean, owner?: XViewReadOwner) {
  const client = useQueryClient();
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const filterKey = JSON.stringify(filters);
  const lifetime = useMemo(
    () => ({ id: ++nextLifetime, filterKey, owner, epoch }),
    [filterKey, owner, epoch],
  );
  const query = useMemo<ScatterQuery>(
    () => ({ ...filters, limit: maxLivePoints, include_summary: true, group_by: "model" }),
    // Stable value identity also protects standalone callers passing object literals.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterKey],
  );
  const key = useMemo(() => ["observability", "xview", "scatter", query, lifetime.id], [lifetime, query]);
  const pollCancel = useRef<(() => void) | undefined>(undefined);
  const [delta, setDelta] = useState<{ receipt: Receipt; buffer: XViewBuffer }>();
  const [retirement, setRetirement] = useState<object>();
  const latestBuffer = useRef<{ lifetime: typeof lifetime; buffer: XViewBuffer } | undefined>(undefined);
  const activeLifetime = useRef<typeof lifetime | undefined>(undefined);
  const deniedLifetime = useRef<typeof lifetime | undefined>(undefined);
  const [readState, setReadState] = useState<{ lifetime: typeof lifetime; denied: boolean }>();
  const denied = readState?.lifetime === lifetime && readState.denied;
  const automaticRead = readState?.lifetime !== lifetime;
  const current = useCallback(
    () =>
      activeLifetime.current === lifetime &&
      epoch === tokenStore.getSessionEpoch() &&
      (!owner || owner.isCurrent()),
    [epoch, lifetime, owner],
  );
  useLayoutEffect(() => {
    activeLifetime.current = lifetime;
    return () => {
      if (activeLifetime.current === lifetime) activeLifetime.current = undefined;
      pollCancel.current?.();
      void client.cancelQueries({ queryKey: key, exact: true });
      client.removeQueries({ queryKey: key, exact: true });
    };
  }, [client, key, lifetime]);
  const deny = useCallback(() => {
    if (!current()) return;
    owner?.onDenied?.();
    deniedLifetime.current = lifetime;
    setReadState({ lifetime, denied: true });
    pollCancel.current?.();
    setDelta(undefined);
    latestBuffer.current = undefined;
    setRetirement({});
    const query = client.getQueryCache().find<Receipt>({ queryKey: key, exact: true });
    if (query)
      notifyManager.batch(() => {
        // Manual safe data also retires TanStack's private cancellation/revert snapshot.
        query.setData(
          {
            report: {
              points: [],
              groups: [],
              truncated: false,
              since: "",
              server_time: "",
              cursor: { ingested_at: "", request_id: "" },
            },
            buffer: empty,
          },
          { manual: true, updatedAt: 0 },
        );
        query.setState({
          data: undefined,
          dataUpdatedAt: 0,
          status: "error",
          error: new AppError(xviewDeniedMessage, { kind: "permission" }),
        });
      });
  }, [client, current, key, lifetime, owner]);
  const snapshot = useQuery({
    queryKey: key,
    enabled: (!owner || owner.readable) && automaticRead,
    gcTime: 0,
    retry: false,
    structuralSharing: false,
    queryFn: async ({ signal }): Promise<Receipt> => {
      const assertCurrent = () => {
        if (signal.aborted || !current()) throw new AppError("종료된 XView 조회입니다.", { kind: "aborted" });
      };
      assertCurrent();
      let report: ScatterResponse;
      try {
        report = await apiClient.request(endpoints.domains.observability.xview.scatter, {
          query,
          signal,
          routeId: "observability.xview.scatter",
        });
      } catch (cause) {
        assertCurrent();
        if (
          isAppError(cause) &&
          (cause.status === 401 || cause.status === 403 || cause.kind === "permission")
        )
          deny();
        // Do not retain raw response bodies/cause/message in this feature's error cache.
        throw new AppError(
          deniedLifetime.current === lifetime ? xviewDeniedMessage : "요청 분포를 불러오지 못했습니다.",
          {
            kind: isAppError(cause) ? cause.kind : "network",
            status: isAppError(cause) ? cause.status : undefined,
            requestId:
              isAppError(cause) &&
              cause.requestId &&
              !containsPotentialSecret(cause.requestId, owner?.prefixes)
                ? cause.requestId
                : undefined,
          },
        );
      }
      assertCurrent();
      if (deniedLifetime.current === lifetime) {
        deniedLifetime.current = undefined;
        setReadState({ lifetime, denied: false });
      }
      const now = performance.now();
      const previousClock =
        latestBuffer.current?.lifetime === lifetime ? latestBuffer.current.buffer.clock : undefined;
      const clock = updateXViewClock(previousClock, report.server_time, now);
      const merged = mergeXViewPoints([], report.points, filters, clock, now);
      // A unique receipt replaces dataUpdatedAt as the async generation boundary.
      return {
        report,
        buffer: {
          ...merged,
          truncated: report.truncated || merged.truncated,
          clock,
          lastUpdatedAt: Date.now(),
          status: "waiting",
        },
      };
    },
    staleTime: 5_000,
  });
  const receipt = snapshot.data;
  const queryState = useSyncExternalStore(
    useCallback((listener) => client.getQueryCache().subscribe(listener), [client]),
    useCallback(
      () => client.getQueryCache().find<Receipt>({ queryKey: key, exact: true })?.state,
      [client, key],
    ),
  );
  const buffer = receipt && !denied ? (delta?.receipt === receipt ? delta.buffer : receipt.buffer) : empty;
  useLayoutEffect(() => {
    latestBuffer.current = { lifetime, buffer };
  }, [buffer, lifetime]);
  const snapshotInvalidated = queryState?.isInvalidated === true;
  const snapshotFetching = queryState?.fetchStatus === "fetching";
  const active =
    live && !filters.to && automaticRead && !snapshot.isError && !snapshotInvalidated && !snapshotFetching;
  useEffect(() => {
    if (!active || !receipt || snapshot.isFetching || !current()) return;
    const ownedQuery = client.getQueryCache().find<Receipt>({ queryKey: key, exact: true });
    const revision = ownedQuery?.state.dataUpdateCount;
    const isCurrent = () =>
      current() &&
      ownedQuery === client.getQueryCache().find({ queryKey: key, exact: true }) &&
      ownedQuery?.state.data === receipt &&
      ownedQuery.state.dataUpdateCount === revision &&
      ownedQuery.state.status === "success" &&
      ownedQuery.state.fetchStatus === "idle" &&
      !ownedQuery.state.isInvalidated;
    const cancel = startXViewPoller({
      filters: query,
      initial: buffer,
      initialCursor: receipt.report.cursor,
      isCurrent,
      publish: (next) => setDelta({ receipt, buffer: next }),
      deny,
    });
    pollCancel.current = cancel;
    return cancel;
    // Buffer updates must not restart the cursor/poll cadence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, client, current, deny, key, query, receipt, snapshot.isFetching]);
  const refresh = useCallback(() => {
    if (!current() || snapshot.isFetching) return;
    pollCancel.current?.();
    void snapshot.refetch();
  }, [current, snapshot]);
  return {
    ...buffer,
    initialPending: snapshot.isPending && snapshot.isFetching,
    initialError: snapshot.isError ? snapshot.error : undefined,
    liveError: buffer.error,
    paused: active && buffer.status === "hidden",
    clockConfirmed: buffer.clock?.confirmed === true,
    clockEstimated: !!buffer.clock && !buffer.clock.confirmed,
    active,
    lifetime,
    refresh,
    denied,
    automaticRead,
    denialBoundary: retirement,
    snapshotInvalidated,
    snapshotFetching,
  };
}
