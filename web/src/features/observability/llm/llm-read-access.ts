import { useQueryClient } from "@tanstack/react-query";
import { useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";

let nextOwner = 0;
export interface LLMReadOwner {
  id: number;
  readable: boolean;
  prefixes: readonly string[];
  isCurrent: () => boolean;
}

export function ownsLLMQuery(key: readonly unknown[], owner: LLMReadOwner): boolean {
  return (
    key[0] === "observability" &&
    key[1] === "llm" &&
    key.at(-2) === "llm-read-owner" &&
    key.at(-1) === owner.id
  );
}

/** A page-local cache lifetime, not a replacement for server role/team authorization. */
export function useLLMReadOwner(): LLMReadOwner {
  const auth = useAuth();
  const context = useContext(FeatureAccessContext);
  const client = useQueryClient();
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const readable =
    (auth.mode === "authenticated" || auth.mode === "legacy" || auth.mode === "open") &&
    context?.featureId === "observability.llm" &&
    context.permitted &&
    (auth.mode !== "authenticated" || auth.user?.scopes.includes("admin:read") === true);
  const identity = JSON.stringify([
    epoch,
    readable,
    context?.featureId,
    auth.mode,
    auth.user?.id,
    auth.user?.role,
    auth.user?.roles,
    auth.user?.team_id,
    auth.capabilities.raw_prompt_view,
    auth.credentialPrefixes,
  ]);
  const active = useRef<LLMReadOwner | undefined>(undefined);
  const owner = useMemo<LLMReadOwner>(() => {
    const value = {
      id: ++nextOwner,
      readable,
      prefixes: auth.credentialPrefixes,
      isCurrent: () => active.current === value && value.readable && epoch === tokenStore.getSessionEpoch(),
    };
    return value;
    // Filters, polling and write-only restrictions deliberately do not retire reads or drafts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);
  useLayoutEffect(() => {
    active.current = owner;
    return () => {
      if (active.current === owner) active.current = undefined;
      const owned = {
        predicate: ({ queryKey }: { queryKey: readonly unknown[] }) =>
          ownsLLMQuery(queryKey, owner) ||
          (queryKey.length === 7 &&
            queryKey[0] === "observability" &&
            queryKey[1] === "requests" &&
            queryKey[3] === "note" &&
            queryKey[5] === "note-read-scope" &&
            queryKey[6] === owner.id),
      };
      void client.cancelQueries(owned);
      client.removeQueries(owned);
    };
  }, [client, owner]);
  return owner;
}
