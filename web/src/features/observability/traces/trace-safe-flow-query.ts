import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import {
  traceSafeFlowQuerySchema,
  type TraceSafeFlowQuery,
} from "@/shared/api/domains/trace-safe-flow.schema";
import type { TraceSafeFlowAccess } from "./trace-safe-flow-access";

export interface TraceFlowSelection extends TraceSafeFlowQuery {
  ready: boolean;
  revision: number;
}

export function useTraceSafeFlowQuery(selection: TraceFlowSelection, access: TraceSafeFlowAccess) {
  const client = useQueryClient();
  const { assertRead } = access;
  const lifetime = useId();
  const { request_ref, created_at, ready, revision } = selection;
  const key = useMemo(
    () => ["admin", "app-request-flow", access.key, request_ref, created_at, lifetime],
    [access.key, request_ref, created_at, lifetime],
  );
  const latest = useRef({ ready, revision });
  const active = useRef(false);
  useLayoutEffect(() => {
    latest.current = { ready, revision };
  });
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const assertCurrent = useCallback(
    (expected: number) => {
      assertRead();
      if (!active.current || !latest.current.ready || latest.current.revision !== expected)
        throw new AppError("현재 목록에서 요청을 다시 확인하세요.", { kind: "aborted" });
    },
    [assertRead],
  );
  const query = useQuery({
    queryKey: key,
    enabled: false,
    retry: false,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      const expected = latest.current.revision;
      assertCurrent(expected);
      const target = traceSafeFlowQuerySchema.parse({ request_ref, created_at });
      const response = await apiClient.request(endpoints.domains.observability.requestFlow, {
        query: target,
        signal,
        routeId: "observability.traces",
      });
      assertCurrent(expected);
      if (signal.aborted) throw new AppError("단계 조회가 취소되었습니다.", { kind: "aborted" });
      if (response.request_ref !== request_ref || response.created_at !== created_at)
        throw new AppError("선택한 요청과 단계 응답이 일치하지 않습니다.", { kind: "contract" });
      return { response, revision: expected };
    },
  });
  const { refetch } = query;
  useEffect(() => {
    if (ready) void refetch({ cancelRefetch: true });
    return () => {
      void client.cancelQueries({ queryKey: key, exact: true });
    };
  }, [client, key, ready, revision, refetch]);
  useEffect(
    () => () => {
      client.removeQueries({ queryKey: key, exact: true });
    },
    [client, key],
  );
  const retry = () => {
    try {
      assertCurrent(revision);
    } catch {
      return;
    }
    if (client.getQueryState(key)?.fetchStatus === "fetching") return;
    void refetch({ cancelRefetch: false });
  };
  return {
    query,
    retry,
    previous: !ready || query.isFetching || query.isError || query.data?.revision !== revision,
  };
}
