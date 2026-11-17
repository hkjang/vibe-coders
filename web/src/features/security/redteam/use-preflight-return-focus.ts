import { useCallback, useRef, type RefObject } from "react";

/** Resolve the current row button after a table render replaces its DOM node. */
export function usePreflightReturnFocus(fallback: RefObject<HTMLElement | null>) {
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const selected = useRef<string | undefined>(undefined);
  const remember = useCallback((id: string) => {
    selected.current = id;
  }, []);
  const register = useCallback((id: string, node: HTMLButtonElement | null) => {
    if (node) triggers.current.set(id, node);
    else triggers.current.delete(id);
  }, []);
  return {
    remember,
    register,
    returnFocusRef: {
      get current(): HTMLElement | null {
        const id = selected.current;
        const trigger = id === undefined ? undefined : triggers.current.get(id);
        return trigger?.isConnected && !trigger.disabled ? trigger : fallback.current;
      },
    },
  };
}
