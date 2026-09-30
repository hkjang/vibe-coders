import { useCallback, useLayoutEffect, useRef } from "react";
import type { RoutingToggleAccess } from "./routing-toggle-access";

type FocusAccess = Pick<RoutingToggleAccess, "assertOwned" | "epoch" | "owner">;

/** Restore only this confirmation's focus when its active control is disabled. */
export function useRoutingTogglePendingFocus({ assertOwned, epoch, owner }: FocusAccess, pending: boolean) {
  const reviewRef = useRef<HTMLDListElement>(null);
  const mounted = useRef(false);
  const captured = useRef<
    | {
        origin: HTMLElement;
        dialog: HTMLElement;
        epoch: number;
        owner: string | undefined;
      }
    | undefined
  >(undefined);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      captured.current = undefined;
    };
  }, []);
  const capture = useCallback(() => {
    captured.current = undefined;
    if (!mounted.current) return;
    try {
      assertOwned();
    } catch {
      return;
    }
    const dialog = reviewRef.current?.closest<HTMLElement>('[role="dialog"]');
    const origin = document.activeElement;
    if (dialog && origin instanceof HTMLElement && origin.closest('[role="dialog"]') === dialog)
      captured.current = { dialog, origin, epoch, owner };
  }, [assertOwned, epoch, owner]);
  useLayoutEffect(() => {
    const previous = captured.current;
    captured.current = undefined;
    if (!pending || !mounted.current || !previous) return;
    const { dialog, origin } = previous;
    if (
      previous.epoch !== epoch ||
      previous.owner !== owner ||
      !dialog.isConnected ||
      !origin.isConnected ||
      !origin.matches(":disabled") ||
      reviewRef.current?.closest('[role="dialog"]') !== dialog ||
      origin.closest('[role="dialog"]') !== dialog ||
      dialog.getAttribute("aria-hidden") === "true" ||
      dialog.getAttribute("data-state") === "closed"
    )
      return;
    try {
      assertOwned();
    } catch {
      return;
    }
    if (document.activeElement === origin || document.activeElement === document.body)
      dialog.focus({ preventScroll: true });
  }, [pending, assertOwned, epoch, owner]);
  return { reviewRef, capture };
}
