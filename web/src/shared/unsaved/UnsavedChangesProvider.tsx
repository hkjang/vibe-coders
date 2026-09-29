import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type PropsWithChildren } from "react";
import { useBlocker } from "react-router";

import { subscribeToLogout } from "@/shared/auth/token-store";
import { UnsavedChangesContext } from "@/shared/unsaved/context";
import { UnsavedChangesCoordinator } from "@/shared/unsaved/coordinator";
import { UnsavedChangesDialog } from "@/shared/unsaved/UnsavedChangesDialog";

/** Mounted once, only inside the production data router (or createMemoryRouter tests). */
function NavigationBlocker({ coordinator }: { coordinator: UnsavedChangesCoordinator }): null {
  const blocker = useBlocker(coordinator.shouldBlock);
  const snapshot = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot);
  useEffect(() => {
    if (blocker.state === "blocked") coordinator.requestNavigation(blocker);
    else coordinator.clearNavigation();
  }, [blocker, coordinator, snapshot.protected]);
  return null;
}

interface Props extends PropsWithChildren {
  enabled?: boolean;
  /** Declarative MemoryRouter has no blocker API; standalone forms still protect closing/unload. */
  blockNavigation?: boolean;
}

export function UnsavedChangesProvider({
  children,
  enabled = true,
  blockNavigation = false,
}: Props): React.JSX.Element {
  const [coordinator] = useState(() => new UnsavedChangesCoordinator());
  const snapshot = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot);

  useLayoutEffect(() => {
    coordinator.setEnabled(enabled);
  }, [coordinator, enabled]);
  useEffect(() => subscribeToLogout(coordinator.discardForSecurity), [coordinator]);
  useEffect(() => {
    if (!enabled || !snapshot.protected) return;
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (!coordinator.shouldBlock()) return;
      event.preventDefault();
      // Browsers own the native warning text and may suppress it without user activation.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [coordinator, enabled, snapshot.protected]);

  return (
    <UnsavedChangesContext.Provider value={coordinator}>
      {children}
      {blockNavigation ? <NavigationBlocker coordinator={coordinator} /> : null}
      <UnsavedChangesDialog
        open={enabled && snapshot.confirmation !== undefined}
        pending={snapshot.pending}
        onKeepEditing={coordinator.keepEditing}
        onDiscard={coordinator.discardConfirmed}
      />
    </UnsavedChangesContext.Provider>
  );
}
