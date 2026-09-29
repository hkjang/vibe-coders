import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState, useSyncExternalStore } from "react";

import { tokenStore } from "@/shared/auth/token-store";

import type { SettingReloadPendingNotice } from "./setting-save-outcome";
import { systemSettingsKeys, type useEffectiveSettings } from "./use-system-settings";

type Settings = NonNullable<ReturnType<typeof useEffectiveSettings>["data"]>;
type Notice = { requestId?: string };

/** Request-local failure evidence survives cached "applied" data until a newer
 * successful read confirms convergence. Counts, not wall-clock timestamps, also
 * distinguish two reads completing in the same millisecond. */
export function useSettingsReloadNotice() {
  const client = useQueryClient();
  const sessionEpoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const subscribe = useCallback((changed: () => void) => client.getQueryCache().subscribe(changed), [client]);
  const snapshot = useCallback(() => client.getQueryState<Settings>(systemSettingsKeys.effective), [client]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [local, setLocal] = useState<SettingReloadPendingNotice & { sessionEpoch: number }>();
  const staleSession = local !== undefined && local.sessionEpoch !== sessionEpoch;
  const converged = Boolean(
    local &&
    // Writes await invalidation before publishing their notice. A failed or
    // unfinished validation can retain an older true value and a newer count;
    // neither is confirmation until the current read succeeds and settles.
    state?.status === "success" &&
    state.fetchStatus === "idle" &&
    state.data?.this_pod?.up_to_date === true &&
    state.dataUpdateCount > local.observedUpdates,
  );
  // Reconcile this component's state before committing the render. Clearing the
  // matching local record makes this branch false on the immediate next render.
  if (converged || staleSession) setLocal(undefined);
  const setReloadPending = (notice: SettingReloadPendingNotice | undefined): void => {
    setLocal(notice ? { ...notice, sessionEpoch: tokenStore.getSessionEpoch() } : undefined);
  };
  const reloadPending: Notice | undefined =
    local && !converged && !staleSession
      ? local
      : state?.data?.this_pod?.up_to_date === false
        ? {}
        : undefined;
  return { reloadPending, setReloadPending };
}
