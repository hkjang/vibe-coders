import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppError, isAppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";

let nextOwner = 0;
export interface ProviderReadOwner {
  id: number;
  readable: boolean;
  denied: boolean;
  isCurrent: () => boolean;
  restart: () => void;
}
export const ProviderReadContext = createContext<ProviderReadOwner | undefined>(undefined);
export const providerOwnedKey = (key: readonly unknown[], owner: ProviderReadOwner) =>
  [...key, "provider-read-owner", owner.id] as const;

export function assertProviderRead(owner: ProviderReadOwner, signal?: AbortSignal): void {
  if (!owner.isCurrent() || signal?.aborted)
    throw new AppError("공급자 조회 화면과 인증 상태가 변경되었습니다.", { kind: "aborted" });
}

/** A local read lifetime; server authorization remains authoritative. */
export function useProviderReadOwner(): ProviderReadOwner {
  const auth = useAuth();
  const feature = useContext(FeatureAccessContext);
  const client = useQueryClient();
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const [revision, setRevision] = useState(0);
  const [, notifyDenial] = useState(0);
  const readable =
    (auth.mode === "authenticated" || auth.mode === "legacy" || auth.mode === "open") &&
    feature?.featureId === "gateway.providers" &&
    feature.permitted === true &&
    feature.status !== "hidden" &&
    feature.status !== "legacy" &&
    (auth.user ? auth.user.scopes.includes("admin:read") : auth.mode !== "authenticated");
  const identity = JSON.stringify([
    epoch,
    feature?.featureId,
    readable,
    auth.mode,
    auth.user?.id,
    auth.user?.team_id,
    auth.user?.role,
    auth.user?.roles,
    auth.user?.scopes.includes("routing:read"),
    auth.credentialPrefixes,
  ]);
  const active = useRef<ProviderReadOwner | undefined>(undefined);
  const owner = useMemo<ProviderReadOwner>(() => {
    const value: ProviderReadOwner = {
      id: ++nextOwner,
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
        queryKey.at(-2) === "provider-read-owner" && queryKey.at(-1) === owner.id,
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

/** Standalone dialogs also receive a local lifetime; page dialogs share their page owner. */
export function useProviderReadScope(): ProviderReadOwner {
  const inherited = useContext(ProviderReadContext);
  const local = useProviderReadOwner();
  return inherited ?? local;
}
