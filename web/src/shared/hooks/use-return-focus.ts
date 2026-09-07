import { useCallback, useRef, type RefObject } from "react";

interface ReturnFocus {
  /** Passed to `Dialog`, `Sheet` or `ConfirmDialog` so focus returns to the trigger. */
  readonly returnFocusRef: RefObject<HTMLElement | null>;
  /** Records the element that opened the overlay, from the trigger's handler. */
  readonly remember: (trigger: HTMLElement | { currentTarget: HTMLElement } | null) => void;
  /** Records whatever currently has focus, for row activation by click or keyboard. */
  readonly rememberActive: () => void;
}

/**
 * Keeps "what opened this overlay" out of render. The setters are stable
 * callbacks, so a table column factory can be handed `remember` without the
 * component reading a ref while rendering.
 */
export function useReturnFocus(): ReturnFocus {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const remember = useCallback((trigger: HTMLElement | { currentTarget: HTMLElement } | null): void => {
    returnFocusRef.current =
      trigger === null ? null : trigger instanceof HTMLElement ? trigger : trigger.currentTarget;
  }, []);
  const rememberActive = useCallback((): void => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, []);
  return { returnFocusRef, remember, rememberActive };
}
