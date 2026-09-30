import { useCallback, useRef, useState, useSyncExternalStore } from "react";

import type { ApiKeyPublic } from "@/shared/api/domains/access.schemas";
import { tokenStore } from "@/shared/auth/token-store";

export function useMeKeyScopeDraft() {
  const [selection, setSelection] = useState<{ row: ApiKeyPublic; epoch: number; instance: number }>();
  const sessionEpoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const nextInstance = useRef(0);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const returnId = useRef<string | undefined>(undefined);
  const open = useCallback((row: ApiKeyPublic, trigger: HTMLElement): void => {
    returnFocusRef.current = trigger;
    returnId.current = row.id;
    setSelection({
      row: { ...row, scopes: [...row.scopes] },
      epoch: tokenStore.getSessionEpoch(),
      instance: ++nextInstance.current,
    });
  }, []);
  const rememberTrigger = useCallback((node: HTMLButtonElement | null, id: string): void => {
    if (node && returnId.current === id) returnFocusRef.current = node;
  }, []);
  const close = useCallback((instance: number): void => {
    // Even a delayed close callback can only discard its own editor instance.
    setSelection((current) => (current?.instance === instance ? undefined : current));
  }, []);

  return {
    target: selection?.epoch === sessionEpoch ? selection : undefined,
    open,
    close,
    returnFocusRef,
    rememberTrigger,
  };
}
