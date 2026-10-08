import { notifyManager, useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { apiClient } from "@/shared/api/client";
import {
  routingDomainDecisionEndpoints,
  type RoutingDomainDecision,
  type RoutingDomainDecisionReport,
  type RoutingDomainDecisionsQuery,
} from "@/shared/api/domains/routing-domain-decisions";
import { AppError, isAppError } from "@/shared/api/error";
import type { DomainDecisionsAccess } from "./domain-decisions-access";
import { domainDecisionChanged, domainDecisionSafeError } from "./domain-decisions-state";
import { routingDomainQueryKey } from "./routing-shared";

export interface DomainDecisionSnapshot {
  query: Query<RoutingDomainDecisionReport>;
  data: RoutingDomainDecisionReport;
  count: number;
  receivedAt: number;
}
export function useDomainDecisionsQuery(filters: RoutingDomainDecisionsQuery, access: DomainDecisionsAccess) {
  const client = useQueryClient();
  const nonce = useId();
  const key = useMemo(
    () => [...routingDomainQueryKey, "decisions", "metadata", access.key, filters, nonce],
    [access.key, filters, nonce],
  );
  const active = useRef(false);
  const denial = useRef(false);
  const [denied, setDenied] = useState(false);
  const [automaticRead, setAutomaticRead] = useState(true);
  const assertRead = (signal?: AbortSignal) => {
    access.assertRead();
    if (!active.current || signal?.aborted)
      throw new AppError("종료된 도메인 결정 조회입니다.", { kind: "aborted" });
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
    enabled: access.readable && automaticRead,
    gcTime: 0,
    retry: false,
    // Preserve literal own signal-map keys such as "__proto__" on every GET.
    // Default structural sharing rebuilds these records through property writes.
    structuralSharing: false,
    queryFn: async ({ signal }) => {
      try {
        assertRead(signal);
        const report = await apiClient.request(routingDomainDecisionEndpoints.report, {
          query: filters,
          signal,
          routeId: "routing.rules",
        });
        assertRead(signal);
        if (report.decisions.length > 50)
          throw new AppError("최대 50건의 조회 경계를 확인할 수 없습니다.", { kind: "contract" });
        denial.current = false;
        setDenied(false);
        return report;
      } catch (cause) {
        // A cancelled request or retired access owner cannot deny a newer view.
        assertRead(signal);
        const error = domainDecisionSafeError(cause, access.prefixes);
        if (
          isAppError(cause) &&
          (cause.status === 401 || cause.status === 403 || cause.kind === "permission")
        ) {
          denial.current = true;
          setDenied(true);
          // Recovery is explicit for this lifetime. Re-enabling a stale observer
          // after manual success would otherwise issue a second, hidden GET.
          setAutomaticRead(false);
          const query = client
            .getQueryCache()
            .find<RoutingDomainDecisionReport>({ queryKey: key, exact: true });
          if (query)
            notifyManager.batch(() => {
              // Clear both public data and Query's cancellation/revert snapshot.
              // A manual safe tombstone retires the old revert data; immediately
              // replace it with an error, never a successful empty response.
              query.setData({ decisions: [], signals: {} }, { manual: true, updatedAt: 0 });
              query.setState({ data: undefined, dataUpdatedAt: 0, status: "error", error });
            });
        }
        throw error;
      }
    },
  });
  const currentQuery = () =>
    client.getQueryCache().find<RoutingDomainDecisionReport>({ queryKey: key, exact: true });
  const renderedQuery = currentQuery();
  const renderedCount = renderedQuery?.state.dataUpdateCount;
  const ready =
    !denied &&
    result.isSuccess &&
    !result.isFetching &&
    !result.isPlaceholderData &&
    renderedQuery?.state.status === "success" &&
    !renderedQuery.state.isInvalidated &&
    renderedQuery.state.fetchStatus === "idle";
  const capture = (item: RoutingDomainDecision): DomainDecisionSnapshot => {
    assertRead();
    const query = currentQuery();
    if (
      denial.current ||
      !ready ||
      !query ||
      query !== renderedQuery ||
      query.state.status !== "success" ||
      query.state.fetchStatus !== "idle" ||
      query.state.isInvalidated ||
      query.state.data !== result.data ||
      query.state.dataUpdateCount !== renderedCount ||
      !query.state.data?.decisions.includes(item)
    )
      throw new AppError(domainDecisionChanged, { kind: "aborted" });
    return {
      query,
      data: query.state.data,
      count: query.state.dataUpdateCount,
      receivedAt: query.state.dataUpdatedAt,
    };
  };
  const isCurrent = (snapshot: DomainDecisionSnapshot) => {
    try {
      assertRead();
      const query = currentQuery();
      return (
        query === snapshot.query &&
        query.state.status === "success" &&
        query.state.fetchStatus === "idle" &&
        !query.state.isInvalidated &&
        query.state.data === snapshot.data &&
        query.state.dataUpdateCount === snapshot.count
      );
    } catch {
      return false;
    }
  };
  const refresh = async () => {
    assertRead();
    if (currentQuery()?.state.fetchStatus !== "idle") return;
    await result.refetch({ throwOnError: true });
    assertRead();
  };
  return { result, ready, denied, automaticRead, capture, isCurrent, refresh };
}
export type DomainDecisionsQuery = ReturnType<typeof useDomainDecisionsQuery>;
