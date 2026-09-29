import { useMutation, useQueryClient, type QueryKey, type UseMutationResult } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { AppError, isAppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

interface MutationFeedbackOptions<Variables, Result> {
  /** Server call. */
  mutate: (variables: Variables) => Promise<Result>;
  /** Query keys (prefixes) to invalidate after success. */
  invalidates?: readonly QueryKey[];
  successMessage?: string | ((result: Result, variables: Variables) => string);
  errorMessage?: string;
  onSuccess?: (result: Result, variables: Variables) => void;
}

/**
 * useMutation with the console's standard feedback: a success toast, an error
 * toast carrying the request ID, and cache invalidation of affected lists.
 * Callers that show errors inline (dialogs) can still read `error`.
 */
export function useMutationFeedback<Variables, Result>({
  errorMessage = "작업을 완료하지 못했습니다.",
  invalidates = [],
  mutate,
  onSuccess,
  successMessage,
}: MutationFeedbackOptions<Variables, Result>): UseMutationResult<Result, Error, Variables> {
  const queryClient = useQueryClient();
  const sessionEpoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  type Submission = { variables: Variables; epoch: number };
  type PublicMutation = UseMutationResult<Result, Error, Variables>;
  const isCurrent = (submission: Submission): boolean => submission.epoch === tokenStore.getSessionEpoch();
  const assertCurrent = (submission: Submission): void => {
    if (!isCurrent(submission)) {
      throw new AppError("인증 세션이 변경되어 이전 작업을 취소했습니다.", { kind: "aborted" });
    }
  };
  const mutation = useMutation<Result, Error, Submission>({
    retry: false,
    mutationFn: async (submission) => {
      assertCurrent(submission);
      try {
        const result = await mutate(submission.variables);
        assertCurrent(submission);
        return result;
      } catch (error) {
        assertCurrent(submission);
        throw error;
      }
    },
    onSuccess: async (result, submission) => {
      if (!isCurrent(submission)) return;
      await Promise.all(invalidates.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      // Invalidation may await refetches while logout/login changes ownership.
      if (!isCurrent(submission)) return;
      const { variables } = submission;
      if (successMessage) {
        toast.success(
          typeof successMessage === "function" ? successMessage(result, variables) : successMessage,
        );
      }
      onSuccess?.(result, variables);
    },
    onError: (error, submission) => {
      if (!isCurrent(submission)) return;
      const requestId = isAppError(error) ? error.requestId : undefined;
      toast.error(safeAppErrorMessage(error, errorMessage), {
        description: requestId ? `요청 ID: ${requestId}` : undefined,
      });
    },
  });
  const { reset } = mutation;
  useEffect(() => {
    if (mutation.variables && mutation.variables.epoch !== sessionEpoch) reset();
  }, [mutation.variables, reset, sessionEpoch]);

  const mutateAsync: PublicMutation["mutateAsync"] = async (...[variables, options]) => {
    // Capture at the public call, not an async onMutate/mutationFn. Each submission
    // owns its generation even when concurrent calls share the same variables.
    const submission: Submission = { variables: variables as Variables, epoch: tokenStore.getSessionEpoch() };
    try {
      const result = await mutation.mutateAsync(submission, {
        onSuccess: (data, value, context, mutationContext) => {
          if (isCurrent(value)) options?.onSuccess?.(data, value.variables, context, mutationContext);
        },
        onError: (error, value, context, mutationContext) => {
          if (isCurrent(value)) options?.onError?.(error, value.variables, context, mutationContext);
        },
        onSettled: (data, error, value, context, mutationContext) => {
          if (isCurrent(value)) options?.onSettled?.(data, error, value.variables, context, mutationContext);
        },
      });
      // Do not resolve into a caller's stale setState/one-time-secret continuation.
      assertCurrent(submission);
      return result;
    } catch (error) {
      assertCurrent(submission);
      throw error;
    }
  };
  const mutateWithFeedback: PublicMutation["mutate"] = (...args) => {
    void mutateAsync(...args).catch(() => undefined);
  };
  if (mutation.isIdle) return { ...mutation, variables: undefined, mutate: mutateWithFeedback, mutateAsync };
  return { ...mutation, variables: mutation.variables.variables, mutate: mutateWithFeedback, mutateAsync };
}
