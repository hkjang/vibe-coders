import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { CompareAccess } from "./use-compare-access";
import { AppError, isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

export type CompareOperationKind = "run" | "judge" | "predict" | "code";

/** One synchronous admission slot; old settlements never release a newer slot. */
export function useCompareOperation(access: CompareAccess) {
  const identity = `${access.epoch}:${access.owner ?? "missing"}:${String(access.known)}`;
  const [pending, setPending] = useState<{ identity: string; kind: CompareOperationKind | "" }>();
  const [error, setError] = useState<{ identity: string; message: string; requestId?: string }>();
  const flight = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flight.current?.abort();
      flight.current = undefined;
    };
  }, [access.epoch, access.owner, access.known]);

  const execute = useCallback(
    async <T>(
      kind: CompareOperationKind,
      request: (signal: AbortSignal, assertAdmission: () => void) => Promise<T>,
      commit: (result: T) => void,
    ): Promise<void> => {
      if (!mounted.current || flight.current) return;
      const current = new AbortController();
      let admitted = false;
      const owned = () => mounted.current && access.isCurrent() && flight.current === current;
      const assertPermission = () => {
        if (kind === "predict") access.assertPredict();
        else if (kind === "code") access.assertRead();
        else access.write.assertCurrent();
      };
      const assertAdmission = () => {
        if (!owned() || current.signal.aborted)
          throw new AppError("이전 비교 작업을 폐기했습니다.", { kind: "aborted" });
        assertPermission();
      };
      try {
        assertPermission();
        flight.current = current;
        admitted = true;
        setPending({ identity, kind });
        setError(undefined);
        assertAdmission();
        const result = await request(current.signal, assertAdmission);
        if (owned()) commit(result);
      } catch (cause) {
        if (owned() || (!admitted && mounted.current && access.isCurrent()))
          setError({
            identity,
            message: safeAppErrorMessage(cause, "요청을 완료하지 못했습니다."),
            requestId: isAppError(cause) ? cause.requestId : undefined,
          });
      } finally {
        if (owned()) {
          flight.current = undefined;
          setPending({ identity, kind: "" });
        }
      }
    },
    [access, identity],
  );
  return {
    pending: pending?.identity === identity ? pending.kind : "",
    error: error?.identity === identity ? error : undefined,
    execute,
  };
}
