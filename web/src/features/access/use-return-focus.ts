import { useCallback, useRef, type RefObject } from "react";

interface ReturnFocus {
  /** Passed to `Dialog`/`Sheet`/`ConfirmDialog` so focus goes back to the trigger. */
  returnFocusRef: RefObject<HTMLElement | null>;
  /** Records the element that opened the overlay. */
  remember: (trigger: HTMLElement | null) => void;
  /** Records whatever currently has focus (row activation via keyboard or click). */
  rememberActive: () => void;
}

/**
 * Keeps the "what opened this overlay" element out of render. The setters are
 * stable callbacks so table column factories can receive them without the
 * component reading a ref during render.
 */
export function useReturnFocus(): ReturnFocus {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const remember = useCallback((trigger: HTMLElement | null): void => {
    returnFocusRef.current = trigger;
  }, []);
  const rememberActive = useCallback((): void => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, []);
  return { returnFocusRef, remember, rememberActive };
}
