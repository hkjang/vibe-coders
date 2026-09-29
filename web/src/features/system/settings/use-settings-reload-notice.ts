import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState, useSyncExternalStore } from "react";

import { systemSettingsKeys, type useEffectiveSettings } from "./use-system-settings";

type Settings = NonNullable<ReturnType<typeof useEffectiveSettings>["data"]>;
type Notice = { requestId?: string };

/** Request-local failure evidence survives cached "applied" data until a newer
 * successful read confirms convergence. Counts, not wall-clock timestamps, also
 * distinguish two reads completing in the same millisecond. */
export function useSettingsReloadNotice() {
  const client = useQueryClient();
  const subscribe = useCallback((changed: () => void) => client.getQueryCache().subscribe(changed), [client]);
  const snapshot = useCallback(() => client.getQueryState<Settings>(systemSettingsKeys.effective), [client]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [local, setLocal] = useState<Notice & { observedUpdates: number }>();
  const converged = Boolean(
    local && state?.data?.this_pod?.up_to_date === true && state.dataUpdateCount > local.observedUpdates,
  );
  // Reconcile this component's state before committing the render. Clearing the
  // matching local record makes this branch false on the immediate next render.
  if (converged) setLocal(undefined);
  const setReloadPending = (notice: Notice | undefined): void => {
    setLocal(notice ? { ...notice, observedUpdates: snapshot()?.dataUpdateCount ?? 0 } : undefined);
  };
  const reloadPending: Notice | undefined =
    local && !converged ? local : state?.data?.this_pod?.up_to_date === false ? {} : undefined;
  return { reloadPending, setReloadPending };
}
