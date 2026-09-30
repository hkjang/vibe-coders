import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { tokenStore } from "@/shared/auth/token-store";
import { useUnsavedChanges } from "@/shared/unsaved/context";
import type { UnsavedDiscardReason } from "@/shared/unsaved/coordinator";

interface DraftGuardOptions {
  dirty: boolean;
  externalPending?: boolean;
  /** Inline editors reset in place instead of unmounting on a local discard. */
  keepMounted?: boolean;
  onDiscard: (reason: UnsavedDiscardReason) => void;
}

/** Registers lifecycle metadata only. Draft values remain in their editor. */
export function useDraftGuard({
  dirty,
  externalPending = false,
  keepMounted = false,
  onDiscard,
}: DraftGuardOptions) {
  const coordinator = useUnsavedChanges();
  if (!coordinator) throw new Error("Draft editor requires an unsaved changes coordinator");
  const [owner] = useState(() => Symbol("draft"));
  const [submitting, setSubmitting] = useState(false);
  const flight = useRef(false);
  const epoch = useRef(0);
  const mounted = useRef(false);
  const afterClose = useRef<(() => void) | undefined>(undefined);
  const pending = submitting || externalPending;

  const discard = useCallback(
    function discardDraft(reason: UnsavedDiscardReason): void {
      epoch.current += 1;
      coordinator.removeForm(owner);
      const continuation = afterClose.current;
      afterClose.current = undefined;
      onDiscard(reason);
      if (keepMounted && reason === "close") {
        coordinator.setForm(owner, {
          dirty: false,
          pending: flight.current || externalPending,
          discard: discardDraft,
        });
      }
      // A recovery confirmation belongs only to an explicitly approved local
      // transition, never route departure, authentication loss, or unmount.
      if (reason === "close") continuation?.();
    },
    [coordinator, externalPending, keepMounted, onDiscard, owner],
  );

  useLayoutEffect(() => {
    coordinator.setForm(owner, { dirty, pending: pending || flight.current, discard });
  }, [coordinator, dirty, discard, owner, pending]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current += 1;
      afterClose.current = undefined;
      coordinator.removeForm(owner);
    };
  }, [coordinator, owner]);

  const requestClose = (continuation?: () => void): void => {
    if (pending || flight.current) return;
    afterClose.current = continuation;
    coordinator.requestClose(owner);
  };

  const run = async <Result>(
    operation: () => Promise<Result>,
    onError: (error: unknown) => void,
    onSaved?: (result: Result) => void,
  ): Promise<void> => {
    if (pending || flight.current || !coordinator.startSubmission(owner)) return;
    flight.current = true;
    afterClose.current = undefined;
    setSubmitting(true);
    const submissionEpoch = epoch.current;
    const sessionEpoch = tokenStore.getSessionEpoch();
    const isCurrent = (): boolean =>
      mounted.current && epoch.current === submissionEpoch && sessionEpoch === tokenStore.getSessionEpoch();
    try {
      const result = await operation();
      if (isCurrent()) {
        // Inline editors stay mounted after success. Their owner updates the
        // baseline and wipes secrets; dialogs retain the default close behavior.
        if (onSaved) onSaved(result);
        else discard("close");
      }
    } catch (error) {
      if (isCurrent()) onError(error);
    } finally {
      flight.current = false;
      if (mounted.current) setSubmitting(false);
      // This mounted owner permits one flight. Security disposal may unmount it;
      // finishSubmission never registers an already removed owner again.
      coordinator.finishSubmission(owner);
    }
  };

  return { pending, requestClose, run };
}
