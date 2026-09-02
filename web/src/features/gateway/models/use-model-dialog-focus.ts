import { useCallback, useEffect, useRef, type RefObject } from "react";

type UpdateModelSearch = (updates: Readonly<Record<string, string | undefined>>, replace?: boolean) => void;

interface ModelDialogFocus {
  closeModel: () => void;
  rememberRowTrigger: (modelKey: string) => void;
  rememberTrigger: (trigger: HTMLElement, modelKey: string) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}

export function useModelDialogFocus(
  selectedModel: string,
  updateSearch: UpdateModelSearch,
): ModelDialogFocus {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const returnFocusModelRef = useRef("");
  const restoreFocusPendingRef = useRef(false);

  useEffect(() => {
    const returnModel = returnFocusModelRef.current;
    const currentTrigger = Array.from(document.querySelectorAll<HTMLElement>("[data-model-trigger]")).find(
      (candidate) => candidate.dataset.modelTrigger === returnModel,
    );
    if (selectedModel !== "") {
      if (currentTrigger) returnFocusRef.current = currentTrigger;
      return;
    }
    if (!restoreFocusPendingRef.current) return;
    restoreFocusPendingRef.current = false;
    const timeout = window.setTimeout(() => {
      const latestTrigger = Array.from(document.querySelectorAll<HTMLElement>("[data-model-trigger]")).find(
        (candidate) => candidate.dataset.modelTrigger === returnModel,
      );
      const returnTarget = latestTrigger ?? returnFocusRef.current;
      if (returnTarget?.isConnected && !returnTarget.matches(":disabled")) returnTarget.focus();
    });
    return () => window.clearTimeout(timeout);
  }, [selectedModel]);

  const rememberTrigger = useCallback((trigger: HTMLElement, modelKey: string): void => {
    returnFocusRef.current = trigger;
    returnFocusModelRef.current = modelKey;
  }, []);

  const rememberRowTrigger = useCallback((modelKey: string): void => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    returnFocusModelRef.current = modelKey;
  }, []);

  const closeModel = useCallback((): void => {
    restoreFocusPendingRef.current = true;
    updateSearch({ model: undefined, model_provider: undefined, source: undefined });
  }, [updateSearch]);

  return { closeModel, rememberRowTrigger, rememberTrigger, returnFocusRef };
}
