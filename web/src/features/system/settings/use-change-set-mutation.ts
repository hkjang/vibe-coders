import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { AppError, isAppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

/** Scoped to the mounted ChangeSet owner, including role/team and token session. */
export function useChangeSetMutation<Variables, Result>({
  mutate,
  invalidates = [],
  successMessage,
  errorMessage,
  onSuccess,
  invalidateOnError = false,
}: {
  mutate: (variables: Variables) => Promise<Result>;
  invalidates?: readonly QueryKey[];
  successMessage?: string | ((result: Result, variables: Variables) => string);
  errorMessage: string;
  onSuccess?: (result: Result, variables: Variables) => void;
  invalidateOnError?: boolean;
}) {
  const client = useQueryClient();
  const [epoch] = useState(tokenStore.getSessionEpoch);
  const live = useRef(false);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const current = () => live.current && epoch === tokenStore.getSessionEpoch();
  const assertCurrent = () => {
    if (!current()) throw new AppError("현재 계정과 화면을 다시 확인하세요.", { kind: "aborted" });
  };
  return useMutation({
    retry: false,
    gcTime: 0,
    mutationFn: async (variables: Variables) => {
      assertCurrent();
      try {
        const result = await mutate(variables);
        assertCurrent();
        return result;
      } catch (error) {
        assertCurrent();
        throw error;
      }
    },
    onSuccess: async (result, variables) => {
      if (!current()) return;
      await Promise.all(invalidates.map((queryKey) => client.invalidateQueries({ queryKey })));
      if (!current()) return;
      if (successMessage)
        toast.success(
          typeof successMessage === "function" ? successMessage(result, variables) : successMessage,
        );
      onSuccess?.(result, variables);
    },
    onError: (error) => {
      if (!current()) return;
      if (invalidateOnError)
        for (const queryKey of invalidates) void client.invalidateQueries({ queryKey, refetchType: "none" });
      toast.error(safeAppErrorMessage(error, errorMessage), {
        description: isAppError(error) && error.requestId ? `요청 ID: ${error.requestId}` : undefined,
      });
    },
  });
}
