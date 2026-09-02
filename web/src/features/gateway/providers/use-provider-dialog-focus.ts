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
    const returnProvider = returnFocusProviderRef.current;
    const currentProviderTrigger = Array.from(
      document.querySelectorAll<HTMLElement>("[data-provider-trigger]"),
    ).find((candidate) => candidate.dataset.providerTrigger === returnProvider);
    const returnTarget = currentProviderTrigger ?? returnFocusRef.current;
    if (returnTarget?.isConnected && !returnTarget.matches(":disabled")) returnTarget.focus();
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
