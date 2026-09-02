import { useCallback, useEffect, useRef, type RefObject } from "react";

type UpdateProviderSearch = (
  updates: Readonly<Record<string, string | undefined>>,
  replace?: boolean,
) => void;

interface ProviderDialogFocus {
  closeProvider: () => void;
  rememberTrigger: (trigger: HTMLElement, provider: string) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  rememberRowTrigger: (provider: string) => void;
}

export function useProviderDialogFocus(
  selectedName: string,
  updateSearch: UpdateProviderSearch,
): ProviderDialogFocus {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const returnFocusProviderRef = useRef("");
  const restoreFocusPendingRef = useRef(false);

  useEffect(() => {
    if (selectedName !== "" || !restoreFocusPendingRef.current) return;
    restoreFocusPendingRef.current = false;
    // Radix and the router both finish their close/navigation work after this
    // effect begins. Restore after that teardown so a late focus guard cleanup
    // cannot move focus back to document.body under a busy browser.
    const timer = setTimeout(() => {
      const returnProvider = returnFocusProviderRef.current;
      const currentProviderTrigger = Array.from(
        document.querySelectorAll<HTMLElement>("[data-provider-trigger]"),
      ).find((candidate) => candidate.dataset.providerTrigger === returnProvider);
      const returnTarget = currentProviderTrigger ?? returnFocusRef.current;
      if (returnTarget?.isConnected && !returnTarget.matches(":disabled")) returnTarget.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [selectedName]);

  const rememberTrigger = useCallback((trigger: HTMLElement, provider: string): void => {
    returnFocusRef.current = trigger;
    returnFocusProviderRef.current = provider;
  }, []);

  const rememberRowTrigger = useCallback((provider: string): void => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    returnFocusProviderRef.current = provider;
  }, []);

  const closeProvider = useCallback((): void => {
    restoreFocusPendingRef.current = true;
    updateSearch({ provider: undefined });
  }, [updateSearch]);

  return { closeProvider, rememberRowTrigger, rememberTrigger, returnFocusRef };
}
