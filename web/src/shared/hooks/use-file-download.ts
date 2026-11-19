import { useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { AppError, isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useFeatureReadOwner, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";

export interface FileDownloadContext {
  signal: AbortSignal;
  assertCurrent: () => void;
}
interface Feedback {
  successMessage?: string;
  errorMessage: string;
  toastErrors?: boolean;
}
interface DownloadError {
  message: string;
  requestId?: string;
}
interface State {
  owner: FeatureReadOwner;
  pending: boolean;
  error?: DownloadError;
}

/** A file never outlives the principal, read permission or filters that requested it. */
export function useFileDownload(featureId: string, contextKey: string, enabled = true) {
  const owner = useFeatureReadOwner(featureId, JSON.stringify(["file-export", contextKey, enabled]));
  const active = useRef<{ owner: FeatureReadOwner; controller: AbortController } | undefined>(undefined);
  const [state, setState] = useState<State>();
  useLayoutEffect(
    () => () => {
      if (active.current?.owner === owner) {
        active.current.controller.abort();
        active.current = undefined;
      }
    },
    [owner],
  );

  const run = async (
    task: (context: FileDownloadContext) => Promise<void>,
    feedback: Feedback,
  ): Promise<void> => {
    if (active.current || !enabled || !owner.isCurrent()) return;
    const flight = { owner, controller: new AbortController() };
    active.current = flight;
    const owns = () => active.current === flight && owner.isCurrent() && !flight.controller.signal.aborted;
    const assertCurrent = () => {
      if (!owns())
        throw new AppError("조회 조건이나 인증 상태가 변경되어 내보내기를 취소했습니다.", {
          kind: "aborted",
        });
    };
    setState({ owner, pending: true });
    try {
      assertCurrent();
      await task({ signal: flight.controller.signal, assertCurrent });
      assertCurrent();
      if (feedback.successMessage) toast.success(feedback.successMessage);
    } catch (cause) {
      if (owns() && !(isAppError(cause) && cause.kind === "aborted")) {
        const error = {
          message: safeAppErrorMessage(cause, feedback.errorMessage),
          requestId: isAppError(cause) ? cause.requestId : undefined,
        };
        setState({ owner, pending: false, error });
        if (feedback.toastErrors !== false)
          toast.error(error.message, {
            description: error.requestId ? `요청 ID: ${error.requestId}` : undefined,
            duration: Number.POSITIVE_INFINITY,
          });
      }
    } finally {
      if (active.current === flight) {
        const current = owns();
        active.current = undefined;
        if (current)
          setState((previous) => (previous?.owner === owner ? { ...previous, pending: false } : previous));
      }
    }
  };
  return {
    run,
    available: enabled && owner.readable,
    pending: state?.owner === owner && state.pending,
    error: state?.owner === owner ? state.error : undefined,
  };
}
