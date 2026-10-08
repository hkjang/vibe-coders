import { useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { apiClient } from "@/shared/api/client";
import {
  routingDomainReviewEndpoints,
  type DomainReviewStatus,
  type RoutingDomainReviewItem,
  type RoutingDomainReviewReport,
} from "@/shared/api/domains/routing-domain-review";
import { AppError } from "@/shared/api/error";
import type { DomainReviewAccess } from "./domain-review-access";
import { domainReviewChanged, domainReviewSafeError } from "./domain-review-state";
import { routingDomainQueryKey } from "./routing-shared";

export interface DomainReviewSnapshot {
  query: Query<RoutingDomainReviewReport>;
  data: RoutingDomainReviewReport;
  count: number;
  revision: number;
}
export function useDomainReviewQuery(
  status: DomainReviewStatus,
  access: DomainReviewAccess,
  onDenied: (error: AppError) => void,
) {
  const client = useQueryClient();
  const nonce = useId();
  const key = useMemo(
    () => [...routingDomainQueryKey, "review", "metadata", access.key, status, nonce],
    [access.key, status, nonce],
  );
  const active = useRef(false);
  const revision = useRef(0);
  const assertRead = (signal?: AbortSignal) => {
    access.assertRead();
    if (!active.current || signal?.aborted)
      throw new AppError("종료된 도메인 검토 조회입니다.", { kind: "aborted" });
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
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        assertRead(signal);
        const report = await apiClient.request(routingDomainReviewEndpoints.queue, {
          query: { status, limit: 50 },
          signal,
          routeId: "routing.rules",
        });
        assertRead(signal);
        return report;
      } catch (cause) {
        const error = domainReviewSafeError(cause, access.prefixes);
        if (error.status === 401 || error.status === 403 || error.kind === "permission") {
          // An authoritative GET denial retires this read/consent lifetime.
          // Ignore late responses belonging to an already cancelled owner.
          assertRead(signal);
          active.current = false;
          onDenied(error);
        }
        throw error;
      }
    },
  });
  const currentQuery = () =>
    client.getQueryCache().find<RoutingDomainReviewReport>({ queryKey: key, exact: true });
  const subscribe = useCallback(
    (notify: () => void) =>
      client.getQueryCache().subscribe((event) => {
        if (
          (event.type === "updated" || event.type === "removed" || event.type === "added") &&
          event.query.queryKey.length === key.length &&
          event.query.queryKey.every((part: unknown, index: number) => part === key[index])
        ) {
          // Even a cancelled refresh that restores identical data retires consent.
          revision.current += 1;
          notify();
        }
      }),
    [client, key],
  );
  const renderedRevision = useSyncExternalStore(subscribe, () => revision.current);
  const renderedQuery = currentQuery();
  const renderedCount = renderedQuery?.state.dataUpdateCount;
  const ready =
    access.readable &&
    result.isSuccess &&
    !result.isFetching &&
    !result.isPlaceholderData &&
    renderedQuery?.state.status === "success" &&
    !renderedQuery.state.isInvalidated &&
    renderedQuery.state.fetchStatus === "idle";
  const capture = (item: RoutingDomainReviewItem): DomainReviewSnapshot => {
    assertRead();
    const query = currentQuery();
    if (
      !query ||
      query !== renderedQuery ||
      !ready ||
      query.state.status !== "success" ||
      query.state.fetchStatus !== "idle" ||
      query.state.isInvalidated ||
      query.state.data !== result.data ||
      query.state.dataUpdateCount !== renderedCount ||
      revision.current !== renderedRevision ||
      !query.state.data?.items.includes(item)
    )
      throw new AppError(domainReviewChanged, { kind: "contract" });
    return { query, data: query.state.data, count: query.state.dataUpdateCount, revision: renderedRevision };
  };
  const isCurrent = (snapshot: DomainReviewSnapshot) => {
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
  const refresh = async () => {
    assertRead();
    if (currentQuery()?.state.fetchStatus !== "idle")
      throw new AppError("검토 목록을 이미 조회하고 있습니다.", { kind: "aborted" });
    await result.refetch({ throwOnError: true });
    assertRead();
  };
  return { result, ready, capture, isCurrent, refresh, assertRead };
}
export type DomainReviewQuery = ReturnType<typeof useDomainReviewQuery>;
