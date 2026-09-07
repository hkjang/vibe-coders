import { useCallback, useRef, type RefObject } from "react";

interface ReturnFocus {
  /** Passed to dialogs and sheets so focus returns to the control that opened them. */
  readonly returnFocusRef: RefObject<HTMLElement | null>;
  /** Call from the trigger's event handler before opening a dialog. */
  readonly remember: (event: { currentTarget: HTMLElement }) => void;
}

export function useReturnFocus(): ReturnFocus {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const remember = useCallback((event: { currentTarget: HTMLElement }): void => {
    returnFocusRef.current = event.currentTarget;
  }, []);
  return { remember, returnFocusRef };
}
