import { useCallback, useMemo, useRef } from "react";

/** Registration only runs in React ref callbacks; resolution only runs at close. */
export function useRoutingToggleFocus(id: string | undefined) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const panel = useRef<HTMLDivElement>(null);
  const register = useCallback((id: string, button: HTMLButtonElement | null) => {
    if (button) buttons.current.set(id, button);
    else buttons.current.delete(id);
  }, []);
  const returnFocusRef = useMemo(
    () => ({
      get current() {
        const button = id === undefined ? undefined : buttons.current.get(id);
        return button?.isConnected && !button.disabled ? button : panel.current;
      },
    }),
    [id],
  );
  return { panel, register, returnFocusRef };
}
