import { useCallback, useRef } from "react";

export type KeyRowAction = "edit" | "revoke";

// Table cells can remount after a query or clock update. Follow the exact key
// and action, never a different row that happens to occupy its old position.
export function useKeyRowFocus() {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const selection = useRef<{ id: string; action: KeyRowAction } | undefined>(undefined);
  const remember = useCallback((id: string, action: KeyRowAction, trigger: HTMLElement) => {
    selection.current = { id, action };
    returnFocusRef.current = trigger;
  }, []);
  const bind = useCallback((node: HTMLButtonElement | null, id: string, action: KeyRowAction) => {
    if (node && selection.current?.id === id && selection.current.action === action)
      returnFocusRef.current = node;
  }, []);
  return { returnFocusRef, remember, bind };
}
