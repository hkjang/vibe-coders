import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { tokenStore } from "@/shared/auth/token-store";

import type { SettingReloadPendingNotice } from "./setting-save-outcome";
import { systemSettingsKeys, type useEffectiveSettings } from "./use-system-settings";

type Settings = NonNullable<ReturnType<typeof useEffectiveSettings>["data"]>;
type Notice = { requestId?: string };
type StoredNotice = SettingReloadPendingNotice & { sessionEpoch: number; queryGeneration: number };
const noticeKey = ["system", "settings", "reload-pending-notice"] as const;
// Opaque browser-memory identities distinguish a recreated (GC/removed) query
// whose dataUpdateCount starts over. No setting values or query objects are
// retained in the notice. Weak keys do not keep discarded queries alive.
const generations = new WeakMap<object, number>();
let nextGeneration = 0;
function queryGeneration(query: object | undefined): number {
  if (!query) return 0;
  let generation = generations.get(query);
  if (generation === undefined) {
    generation = ++nextGeneration;
    generations.set(query, generation);
  }
  return generation;
}

/** Session-local failure evidence survives tab/route unmount and cached
 * "applied" data until a newer successful read confirms convergence. */
export function useSettingsReloadNotice() {
  const client = useQueryClient();
  const sessionEpoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  // Cache only outcome metadata, never drafts/secrets or browser storage. Auth
  // boundaries clear this QueryClient; epoch checks also protect same instances.
  useQuery({
    queryKey: noticeKey,
    queryFn: (): StoredNotice | null => null,
    initialData: null,
    enabled: false,
    gcTime: Infinity,
  });
  const subscribe = useCallback((changed: () => void) => client.getQueryCache().subscribe(changed), [client]);
  const snapshot = useCallback(() => client.getQueryState<Settings>(systemSettingsKeys.effective), [client]);
  const noticeSnapshot = useCallback(() => client.getQueryData<StoredNotice | null>(noticeKey), [client]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const local = useSyncExternalStore(subscribe, noticeSnapshot, noticeSnapshot);
  const generation = queryGeneration(
    client.getQueryCache().find({ queryKey: systemSettingsKeys.effective, exact: true }),
  );
  const staleSession = Boolean(local && local.sessionEpoch !== sessionEpoch);
  const converged = Boolean(
    local &&
    // Writes await invalidation before publishing their notice. A failed or
    // unfinished validation can retain an older true value and a newer count;
    // neither is confirmation until the current read succeeds and settles.
    state?.status === "success" &&
    state.fetchStatus === "idle" &&
    state.data?.this_pod?.up_to_date === true &&
    (generation === local.queryGeneration
      ? state.dataUpdateCount > local.observedUpdates
      : state.dataUpdateCount > 0),
  );
  useEffect(() => {
    // Do not let another subscriber's old effect erase a newer write outcome.
    if ((converged || staleSession) && client.getQueryData(noticeKey) === local) {
      client.setQueryData(noticeKey, null);
    }
  }, [client, converged, local, staleSession]);
  const setReloadPending = (notice: SettingReloadPendingNotice | undefined): void => {
    // A callback retained by an unmounted/old session cannot repopulate metadata.
    if (sessionEpoch !== tokenStore.getSessionEpoch()) return;
    const stored: StoredNotice | null = notice
      ? {
          ...(notice.requestId === undefined ? {} : { requestId: notice.requestId }),
          observedUpdates: notice.observedUpdates,
          sessionEpoch,
          queryGeneration: queryGeneration(
            client.getQueryCache().find({ queryKey: systemSettingsKeys.effective, exact: true }),
          ),
        }
      : null;
    client.setQueryData<StoredNotice | null>(noticeKey, () => stored);
  };
  const reloadPending: Notice | undefined =
    local && !converged && !staleSession
      ? local
      : state?.data?.this_pod?.up_to_date === false
        ? {}
        : undefined;
  return { reloadPending, setReloadPending };
}
