import { useMutation, useQueryClient, type QueryKey, type UseMutationResult } from "@tanstack/react-query";
import { toast } from "sonner";

import { isAppError } from "@/shared/api/error";
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
  return useMutation<Result, Error, Variables>({
    mutationFn: mutate,
    onSuccess: async (result, variables) => {
      await Promise.all(invalidates.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      if (successMessage) {
        toast.success(
          typeof successMessage === "function" ? successMessage(result, variables) : successMessage,
        );
      }
      onSuccess?.(result, variables);
    },
    onError: (error) => {
      const requestId = isAppError(error) ? error.requestId : undefined;
      toast.error(safeAppErrorMessage(error, errorMessage), {
        description: requestId ? `요청 ID: ${requestId}` : undefined,
      });
    },
  });
}
