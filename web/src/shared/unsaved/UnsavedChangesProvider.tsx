import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";
import { useBlocker, useLocation, useNavigation } from "react-router";

import { subscribeToLogout } from "@/shared/auth/token-store";
import { UnsavedChangesContext } from "@/shared/unsaved/context";
import { UnsavedChangesCoordinator } from "@/shared/unsaved/coordinator";
import { UnsavedChangesDialog } from "@/shared/unsaved/UnsavedChangesDialog";

/** Mounted once, only inside the production data router (or createMemoryRouter tests). */
function NavigationBlocker({
  coordinator,
  enabled,
}: {
  coordinator: UnsavedChangesCoordinator;
  enabled: boolean;
}): null {
  const blocker = useBlocker(coordinator.shouldBlock);
  const location = useLocation();
  const navigation = useNavigation();
  const snapshot = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot);
  const focusFromKey = useRef<string | undefined>(undefined);
  const focusFrame = useRef<number | undefined>(undefined);
  const cancelNavigationFocus = useCallback((): void => {
    focusFromKey.current = undefined;
    if (focusFrame.current !== undefined) window.cancelAnimationFrame(focusFrame.current);
    focusFrame.current = undefined;
  }, []);

  useEffect(() => subscribeToLogout(cancelNavigationFocus), [cancelNavigationFocus]);
  useEffect(() => cancelNavigationFocus, [cancelNavigationFocus]);
  useLayoutEffect(() => {
    if (!enabled) cancelNavigationFocus();
  }, [cancelNavigationFocus, enabled]);
  useEffect(() => {
    if (blocker.state === "blocked") {
      coordinator.requestNavigation({
        proceed: () => {
          // Only an explicitly discarded route attempt owns destination focus.
          // Keep/local-close retain their existing input/trigger restoration.
          focusFromKey.current = location.key;
          blocker.proceed();
        },
        reset: blocker.reset,
      });
    } else coordinator.clearNavigation();
  }, [blocker, coordinator, location.key, snapshot.protected]);
  useEffect(() => {
    const fromKey = focusFromKey.current;
    if (!enabled || navigation.state !== "idle" || fromKey === undefined || fromKey === location.key) return;
    // Wait for the destination commit and the closing Radix focus scopes. A
    // security transition cancels this frame instead of focusing its login UI.
    const frame = window.requestAnimationFrame(() => {
      focusFrame.current = undefined;
      if (focusFromKey.current !== fromKey) return;
      focusFromKey.current = undefined;
      document.getElementById("main-content")?.focus();
    });
    focusFrame.current = frame;
    return () => {
      window.cancelAnimationFrame(frame);
      if (focusFrame.current === frame) focusFrame.current = undefined;
    };
  }, [enabled, location.key, navigation.state]);
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
      {blockNavigation ? <NavigationBlocker coordinator={coordinator} enabled={enabled} /> : null}
      <UnsavedChangesDialog
        open={enabled && snapshot.confirmation !== undefined}
        pending={snapshot.pending}
        onKeepEditing={coordinator.keepEditing}
        onDiscard={coordinator.discardConfirmed}
      />
    </UnsavedChangesContext.Provider>
  );
}
