import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import {
  traceSafeFlowQuerySchema,
  type TraceSafeFlowQuery,
} from "@/shared/api/domains/trace-safe-flow.schema";
import type { TraceSafeFlowAccess } from "./trace-safe-flow-access";
import { featureOwnedKey } from "@/shared/hooks/use-feature-read-owner";
import { useTraceReadScope } from "./trace-read-scope";

export interface TraceFlowSelection extends TraceSafeFlowQuery {
  ready: boolean;
  revision: number;
  /** Request Explorer additionally fences the actual parent QueryCache at admission/settlement. */
  assertParent?: () => void;
}

export function useTraceSafeFlowQuery(selection: TraceFlowSelection, access: TraceSafeFlowAccess) {
  const client = useQueryClient();
  const scope = useTraceReadScope(access, "trace-flow-read");
  const owner = scope.owner;
  const denied = owner.denied;
  const { assertRead } = access;
  const lifetime = useId();
  const { request_ref, created_at, ready, revision, assertParent } = selection;
  const key = useMemo(
    () =>
      featureOwnedKey(["admin", "app-request-flow", access.key, request_ref, created_at, lifetime], owner),
    [access.key, request_ref, created_at, lifetime, owner],
  );
  const latest = useRef({ ready, revision, assertParent });
  const active = useRef(false);
  useLayoutEffect(() => {
    latest.current = { ready, revision, assertParent };
  });
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const assertSelection = (expected: number) => {
    assertRead();
    latest.current.assertParent?.();
    if (!active.current || !latest.current.ready || latest.current.revision !== expected)
      throw new AppError("현재 목록에서 요청을 다시 확인하세요.", { kind: "aborted" });
  };
  const assertCurrent = (expected: number, signal?: AbortSignal) => {
    scope.assertCurrent(signal);
    assertSelection(expected);
  };
  const query = useQuery({
    queryKey: key,
    enabled: false,
    retry: false,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      const expected = latest.current.revision;
      assertCurrent(expected, signal);
      const target = traceSafeFlowQuerySchema.parse({ request_ref, created_at });
      try {
        const response = await apiClient.request(endpoints.domains.observability.requestFlow, {
          query: target,
          signal,
          routeId: access.routeId,
        });
        assertCurrent(expected, signal);
        if (response.request_ref !== request_ref || response.created_at !== created_at)
          throw new AppError("선택한 요청과 단계 응답이 일치하지 않습니다.", { kind: "contract" });
        return { response, revision: expected };
      } catch (error) {
        assertCurrent(expected, signal);
        scope.captureDenial(error);
        throw error;
      }
    },
  });
  const { refetch } = query;
  useEffect(() => {
    if (ready && !denied) void refetch({ cancelRefetch: true });
    return () => {
      void client.cancelQueries({ queryKey: key, exact: true });
    };
  }, [client, key, ready, revision, refetch, denied]);
  useEffect(
    () => () => {
      client.removeQueries({ queryKey: key, exact: true });
    },
    [client, key],
  );
  const retry = () => {
    if (denied) {
      try {
        assertSelection(revision);
        scope.restart();
      } catch {
        /* A denied parent cannot restart its child. */
      }
      return;
    }
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
    denied,
    denialRequestId: scope.requestId,
    previous: !ready || query.isFetching || query.isError || query.data?.revision !== revision,
  };
}
