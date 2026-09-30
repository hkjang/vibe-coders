import { useCallback, useRef, useState, useSyncExternalStore } from "react";

import type { ApiKeyPublic } from "@/shared/api/domains/access.schemas";
import { tokenStore } from "@/shared/auth/token-store";

export function useApiKeyScopeDraft() {
  const [selection, setSelection] = useState<{ row: ApiKeyPublic; epoch: number }>();
  const sessionEpoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const returnId = useRef<string | undefined>(undefined);
  const open = useCallback((row: ApiKeyPublic, trigger: HTMLElement): void => {
    returnFocusRef.current = trigger;
    returnId.current = row.id;
    setSelection({ row, epoch: tokenStore.getSessionEpoch() });
  }, []);
  const rememberTrigger = useCallback((node: HTMLButtonElement | null, id: string): void => {
    // Refetch may remount cells: follow only this key's scope action.
    if (node && returnId.current === id) returnFocusRef.current = node;
  }, []);
  const close = useCallback(() => setSelection(undefined), []);

  return {
    target: selection?.epoch === sessionEpoch ? selection : undefined,
    open,
    close,
    returnFocusRef,
    rememberTrigger,
  };
}
