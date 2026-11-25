import {
  useMutation,
  type QueryClient,
  type UseMutationOptions,
  type UseMutationResult,
} from "@tanstack/react-query";
import {
  captureAction,
  type ActionCompletion,
  type ActionSelection,
} from "@/shared/telemetry/action-channel";

/**
 * Observe an explicitly classified operation after its mutationFn validates the
 * acknowledgement. Presentation callbacks are not evidence of a server write.
 * Asynchronous job submission must use run_request, never save/completed-run.
 * false explicitly excludes previews, preflight reads and local-only changes.
 */
export function useObservedMutation<Result = unknown, Failure = Error, Variables = void, Context = unknown>(
  {
    observation,
    ...options
  }: UseMutationOptions<Result, Failure, Variables, Context> & {
    observation: ActionSelection<Variables>;
  },
  client?: QueryClient,
): UseMutationResult<Result, Failure, Variables, Context> {
  type Submission = { value: Variables; completion?: ActionCompletion };
  type Public = UseMutationResult<Result, Failure, Variables, Context>;
  const onMutate = options.onMutate;
  const mutation = useMutation<Result, Failure, Submission, Context>(
    {
      ...options,
      retry: false,
      mutationFn: async (submission, context) => {
        try {
          if (!options.mutationFn) throw new Error("변경 처리 함수를 확인하세요.");
          const result = await options.mutationFn(submission.value, context);
          submission.completion?.success();
          return result;
        } catch (error) {
          submission.completion?.failure(error);
          throw error;
        }
      },
      onMutate: onMutate ? (submission, context) => onMutate(submission.value, context) : undefined,
      onSuccess: (result, submission, previous, context) =>
        options.onSuccess?.(result, submission.value, previous, context),
      onError: (error, submission, previous, context) =>
        options.onError?.(error, submission.value, previous, context),
      onSettled: (result, error, submission, previous, context) =>
        options.onSettled?.(result, error, submission.value, previous, context),
    },
    client,
  );
  const mutateAsync: Public["mutateAsync"] = (...[value, callbacks]) =>
    mutation.mutateAsync(
      {
        value: value as Variables,
        completion: captureAction(observation, value as Variables),
      },
      {
        onSuccess: (result, submission, previous, context) =>
          callbacks?.onSuccess?.(result, submission.value, previous, context),
        onError: (error, submission, previous, context) =>
          callbacks?.onError?.(error, submission.value, previous, context),
        onSettled: (result, error, submission, previous, context) =>
          callbacks?.onSettled?.(result, error, submission.value, previous, context),
      },
    );
  const mutate: Public["mutate"] = (...args) => {
    void mutateAsync(...args).catch(() => undefined);
  };
  if (mutation.isIdle) return { ...mutation, variables: undefined, mutate, mutateAsync };
  return { ...mutation, variables: mutation.variables.value, mutate, mutateAsync };
}
