import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ChatAccess } from "./use-chat-access";
import { isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

/** Pure local/server calculations: readonly does not supply or remove API scopes. */
export function useChatComputation<T>(access: ChatAccess, kind: "preview" | "code") {
  const [result, setResult] = useState<T>();
  const [error, setError] = useState<{ message: string; requestId?: string }>();
  const [pending, setPending] = useState(false);
  const flight = useRef<object | undefined>(undefined);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flight.current = undefined;
    };
  }, []);
  const run = useCallback(
    async (execute: () => Promise<T>): Promise<void> => {
      if (flight.current) return;
      const active = {};
      let admitted = false;
      const owned = () => mounted.current && access.isCurrent() && flight.current === active;
      try {
        access.assertComputation(kind);
        flight.current = active;
        admitted = true;
        setPending(true);
        setError(undefined);
        const next = await execute();
        if (owned()) setResult(next);
      } catch (cause) {
        if (owned() || (!admitted && mounted.current && access.isCurrent())) {
          setError({
            message: safeAppErrorMessage(cause, "계산을 완료하지 못했습니다."),
            requestId: isAppError(cause) ? cause.requestId : undefined,
          });
        }
      } finally {
        if (owned()) {
          flight.current = undefined;
          setPending(false);
        }
      }
    },
    [access, kind],
  );
  const clear = () => {
    if (!mounted.current || !access.isCurrent()) return;
    flight.current = undefined;
    setPending(false);
    setResult(undefined);
    setError(undefined);
  };
  return { result, error, pending, run, clear };
}
