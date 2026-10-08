import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { useRequestDetailReadScope } from "@/features/observability/request-insight/request-detail-read-scope";
import { isAppError, type AppError } from "@/shared/api/error";
import { ownsLLMQuery, type LLMReadOwner } from "./llm-read-access";
import { llmReadError } from "./llm-read-query";

let nextLease = 0;

/** Auth ownership survives a denied read; its displayed responses never do. */
export function useLLMReadLifetime(principal: LLMReadOwner) {
  const client = useQueryClient();
  const [revision, setRevision] = useState(0);
  const [, notifyDenial] = useState(0);
  const active = useRef<LLMReadOwner | undefined>(undefined);
  const suspended = useRef(false);
  const lease = useMemo(() => {
    const value = {
      ...principal,
      id: --nextLease,
      retired: false,
      denial: undefined as AppError | undefined,
      isCurrent: () => active.current === value && !value.retired && principal.isCurrent(),
    };
    return value;
    // A new lease is an explicit recovery action, never a poll/filter receipt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [principal, revision]);
  const detailScope = useRequestDetailReadScope(lease, lease.isCurrent);
  const noteScope = useMemo(
    () => ({
      id: principal.id,
      isCurrent: () => principal.isCurrent() && !suspended.current,
    }),
    [principal],
  );
  const retention = useMemo(
    () => ({
      owner: principal,
      isCurrent: principal.isCurrent,
      isSuspended: () => suspended.current,
      readScope: noteScope,
    }),
    [noteScope, principal],
  );

  useLayoutEffect(() => {
    active.current = lease;
    const owned = {
      predicate: ({ queryKey: key }: { queryKey: readonly unknown[] }) =>
        ownsLLMQuery(key, lease) ||
        (key[0] === "observability" &&
          key[1] === "requests" &&
          ((key.length === 7 &&
            key[3] === "note" &&
            key[5] === "note-read-scope" &&
            key[6] === noteScope.id) ||
            (key.length === 6 &&
              ["explain", "trace", "links"].includes(String(key[3])) &&
              key[4] === "read-scope" &&
              key[5] === detailScope.id))),
    };
    const clear = () => {
      void client.cancelQueries(owned);
      client.removeQueries(owned);
    };
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (
        event.type !== "updated" ||
        event.action.type !== "error" ||
        !lease.isCurrent() ||
        client.getQueryCache().get(event.query.queryHash) !== event.query ||
        !owned.predicate(event.query)
      )
        return;
      const error = event.query.state.error;
      if (!isAppError(error) || (error.status !== 401 && error.status !== 403)) return;
      // Invalidate callbacks before cancellation notifications or React commits.
      suspended.current = true;
      lease.retired = true;
      lease.denial = llmReadError(error, principal);
      clear();
      notifyDenial((count) => count + 1);
    });
    return () => {
      unsubscribe();
      if (active.current === lease) active.current = undefined;
      clear();
    };
  }, [client, detailScope.id, lease, noteScope.id, principal]);

  return {
    owner: lease,
    principal,
    detailScope,
    retention,
    denied: lease.retired,
    restart: () => {
      if (principal.isCurrent() && lease.retired) setRevision((count) => count + 1);
    },
    resumeNote: () => {
      if (lease.isCurrent()) suspended.current = false;
    },
  };
}

export type LLMReadLifetime = ReturnType<typeof useLLMReadLifetime>;
