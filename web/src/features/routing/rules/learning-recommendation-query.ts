import { useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { apiClient } from "@/shared/api/client";
import {
  routingLearningEndpoints,
  type RoutingLearningRecommendation,
  type RoutingLearningReport,
} from "@/shared/api/domains/routing-learning";
import { AppError } from "@/shared/api/error";
import type { LearningRecommendationAccess } from "./learning-recommendation-access";
import { recommendationChanged, type LearningWindow } from "./learning-recommendation-state";
import { routingLearningQueryKey } from "./routing-shared";

export interface RecommendationSnapshot {
  query: Query<RoutingLearningReport>;
  data: RoutingLearningReport;
  count: number;
  revision: number;
}
export function useLearningRecommendationQuery(window: LearningWindow, access: LearningRecommendationAccess) {
  const client = useQueryClient();
  const life = useId();
  const key = useMemo(
    () => [...routingLearningQueryKey, access.key, window, life],
    [access.key, window, life],
  );
  const active = useRef(false);
  const revision = useRef(0);
  const assertRead = (signal?: AbortSignal) => {
    access.assertRead();
    if (!active.current || signal?.aborted)
      throw new AppError("종료된 추천 조회입니다.", { kind: "aborted" });
  };
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      void client.cancelQueries({ queryKey: key, exact: true });
      client.removeQueries({ queryKey: key, exact: true });
    };
  }, [client, key]);
  const result = useQuery({
    queryKey: key,
    enabled: access.readable,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      assertRead(signal);
      const response = await apiClient.request(routingLearningEndpoints.report, {
        query: { window },
        routeId: "routing.rules",
        signal,
      });
      assertRead(signal);
      return response;
    },
  });
  const currentQuery = () =>
    client.getQueryCache().find<RoutingLearningReport>({ queryKey: key, exact: true });
  const subscribe = useCallback(
    (notify: () => void) =>
      client.getQueryCache().subscribe((event) => {
        if (
          (event.type === "updated" || event.type === "removed" || event.type === "added") &&
          event.query.queryKey.length === key.length &&
          event.query.queryKey.every((part: unknown, index: number) => part === key[index])
        ) {
          // Retire approval on pending/error/invalidation even if cancellation
          // later restores the same data and dataUpdateCount under a frozen clock.
          revision.current += 1;
          notify();
        }
      }),
    [client, key],
  );
  const renderedRevision = useSyncExternalStore(subscribe, () => revision.current);
  const renderedQuery = currentQuery();
  const renderedCount = renderedQuery?.state.dataUpdateCount;
  const capture = (item: RoutingLearningRecommendation): RecommendationSnapshot => {
    assertRead();
    const query = currentQuery();
    if (
      !query ||
      query !== renderedQuery ||
      query.state.status !== "success" ||
      query.state.fetchStatus !== "idle" ||
      query.state.isInvalidated ||
      !result.isSuccess ||
      result.isPlaceholderData ||
      query.state.data !== result.data ||
      query.state.dataUpdateCount !== renderedCount ||
      revision.current !== renderedRevision ||
      !query.state.data?.recommendations.includes(item)
    )
      throw new AppError(recommendationChanged, { kind: "contract" });
    return { query, data: query.state.data, count: query.state.dataUpdateCount, revision: renderedRevision };
  };
  const isCurrent = (snapshot: RecommendationSnapshot) => {
    try {
      assertRead();
      const query = currentQuery();
      return (
        query === snapshot.query &&
        query.state.status === "success" &&
        query.state.fetchStatus === "idle" &&
        !query.state.isInvalidated &&
        query.state.data === snapshot.data &&
        query.state.dataUpdateCount === snapshot.count &&
        revision.current === snapshot.revision
      );
    } catch {
      return false;
    }
  };
  const refresh = () => {
    try {
      assertRead();
      if (currentQuery()?.state.fetchStatus !== "idle") return;
      void result.refetch();
    } catch {
      /* An old window/owner callback must not restart a GET. */
    }
  };
  const ready =
    access.readable &&
    result.isSuccess &&
    !result.isFetching &&
    !result.isPlaceholderData &&
    renderedQuery?.state.status === "success" &&
    !renderedQuery.state.isInvalidated &&
    renderedQuery.state.fetchStatus === "idle";
  return { result, ready, capture, isCurrent, refresh, assertRead };
}
export type LearningRecommendationQuery = ReturnType<typeof useLearningRecommendationQuery>;
