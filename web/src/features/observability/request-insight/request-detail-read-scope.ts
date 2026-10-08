import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef } from "react";

import { AppError } from "@/shared/api/error";

export interface RequestDetailReadScope {
  readonly id: number;
  isCurrent: () => boolean;
}

let nextReadScope = 0;

/** Opt-in cache ownership; this does not grant read permission or remount note forms. */
export function useRequestDetailReadScope(owner: object, currentRead: () => boolean): RequestDetailReadScope {
  const client = useQueryClient();
  const active = useRef<RequestDetailReadScope | undefined>(undefined);
  const scope = useMemo(() => {
    const value = {
      owner,
      id: ++nextReadScope,
      isCurrent: () => active.current === value && currentRead(),
    };
    return value;
  }, [currentRead, owner]);

  useLayoutEffect(() => {
    active.current = scope;
    return () => {
      if (active.current === scope) active.current = undefined;
      // Preserve ordinary same-owner fresh-cache reopening, but never retain a
      // retired owner's data or allow its pending reads to refill the cache.
      const owned = {
        predicate: ({ queryKey }: { queryKey: readonly unknown[] }) =>
          queryKey.length === 6 &&
          queryKey[0] === "observability" &&
          queryKey[1] === "requests" &&
          typeof queryKey[2] === "string" &&
          (queryKey[3] === "explain" || queryKey[3] === "trace" || queryKey[3] === "links") &&
          queryKey[4] === "read-scope" &&
          queryKey[5] === scope.id,
      };
      void client.cancelQueries(owned);
      client.removeQueries(owned);
    };
  }, [client, scope]);
  return scope;
}

export function requestDetailQueryOptions<T>(
  scope: RequestDetailReadScope | undefined,
  requestId: string,
  kind: "explain" | "trace" | "links",
  request: (signal: AbortSignal) => Promise<T>,
) {
  return {
    // Keep existing request-prefix invalidation compatible.
    queryKey: scope
      ? ["observability", "requests", requestId, kind, "read-scope", scope.id]
      : ["observability", "requests", requestId, kind],
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<T> => {
      const assertCurrent = () => {
        if (scope && (signal.aborted || !scope.isCurrent()))
          throw new AppError("종료된 요청 상세 조회입니다.", { kind: "aborted" });
      };
      assertCurrent();
      try {
        const result = await request(signal);
        assertCurrent();
        return result;
      } catch (error) {
        assertCurrent();
        throw error;
      }
    },
  };
}
