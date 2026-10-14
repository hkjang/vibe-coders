import { useQueryClient } from "@tanstack/react-query";
import { useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppError, isAppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";

let nextOwner = 0;
export interface FeatureReadOwner {
  id: number;
  marker: string;
  readable: boolean;
  denied: boolean;
  isCurrent: () => boolean;
  restart: () => void;
}
export const featureOwnedKey = (key: readonly unknown[], owner: FeatureReadOwner) =>
  [...key, owner.marker, owner.id] as const;

export function assertFeatureRead(owner: FeatureReadOwner, signal?: AbortSignal): void {
  if (!owner.isCurrent() || signal?.aborted)
    throw new AppError("조회 화면과 인증 상태가 변경되었습니다.", { kind: "aborted" });
}

/** A local read lifetime; server authorization remains authoritative. */
export function useFeatureReadOwner(
  featureId: string,
  marker: string,
  readScopes: readonly string[] = [],
  requiredReadScope = "admin:read",
): FeatureReadOwner {
  const auth = useAuth();
  const feature = useContext(FeatureAccessContext);
  const client = useQueryClient();
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const [revision, setRevision] = useState(0);
  const [, notifyDenial] = useState(0);
  const readable =
    (auth.mode === "authenticated" || auth.mode === "legacy" || auth.mode === "open") &&
    feature?.featureId === featureId &&
    feature.permitted === true &&
    feature.status !== "hidden" &&
    feature.status !== "legacy" &&
    (auth.user ? auth.user.scopes.includes(requiredReadScope) : auth.mode !== "authenticated");
  const identity = JSON.stringify([
    epoch,
    feature?.featureId,
    readable,
    requiredReadScope,
    auth.mode,
    auth.user?.id,
    auth.user?.team_id,
    auth.user?.role,
    auth.user?.roles,
    readScopes.map((scope) => auth.user?.scopes.includes(scope)),
    marker,
    auth.credentialPrefixes,
  ]);
  const active = useRef<FeatureReadOwner | undefined>(undefined);
  const owner = useMemo<FeatureReadOwner>(() => {
    const value: FeatureReadOwner = {
      id: ++nextOwner,
      marker,
      readable,
      denied: false,
      isCurrent: () =>
        active.current === value && value.readable && !value.denied && epoch === tokenStore.getSessionEpoch(),
      restart: () => {
        if (active.current === value && value.readable && value.denied)
          setRevision((previous) => previous + 1);
      },
    };
    return value;
    // A new identity never reuses a prior lifetime, including A -> B -> A.
    // Write-only restrictions and filters intentionally preserve the current draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, revision]);
  useLayoutEffect(() => {
    active.current = owner;
    const owned = {
      predicate: ({ queryKey }: { queryKey: readonly unknown[] }) =>
        queryKey.at(-2) === owner.marker && queryKey.at(-1) === owner.id,
    };
    const clear = () => {
      void client.cancelQueries(owned);
      client.removeQueries(owned);
    };
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (
        event.type !== "updated" ||
        event.action.type !== "error" ||
        client.getQueryCache().get(event.query.queryHash) !== event.query ||
        !owned.predicate(event.query) ||
        !owner.isCurrent()
      )
        return;
      const error = event.query.state.error;
      if (!isAppError(error) || (error.status !== 401 && error.status !== 403)) return;
      owner.denied = true;
      clear();
      notifyDenial((value) => value + 1);
    });
    return () => {
      unsubscribe();
      if (active.current === owner) active.current = undefined;
      clear();
    };
  }, [client, owner]);
  return owner;
}
