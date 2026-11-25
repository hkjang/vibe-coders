import { useLayoutEffect, useRef } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { AppError } from "@/shared/api/error";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { assertFeatureRead, featureOwnedKey } from "@/shared/hooks/use-feature-read-owner";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useSettingsWorkspace } from "./settings-workspace-context";
import {
  captureAction,
  type ActionCompletion,
  type ActionSelection,
} from "@/shared/telemetry/action-channel";

export function useSettingsWriteAccess(authorized = true) {
  return useFeatureMutationAccess(
    ["system.settings"],
    authorized,
    "이 작업에 필요한 설정 변경 권한이 없습니다.",
  );
}
interface Options<V, R> {
  observation: ActionSelection<V>;
  /** An acknowledged domain result may encode a refusal without throwing. */
  observationError?: (result: R) => unknown;
  mutate: (value: V) => Promise<R>;
  invalidates?: readonly QueryKey[];
  errorMessage: string;
  successMessage?: string;
  onSuccess?: (result: R, value: V) => void;
  /** Exports are reads; connection tests and all settings changes are writes. */
  readOnly?: boolean;
  authorized?: boolean;
}
export function useSettingsMutation<V, R>(options: Options<V, R>) {
  const { owner } = useSettingsWorkspace();
  const access = useSettingsWriteAccess(options.authorized ?? true);
  const client = useQueryClient();
  const mounted = useRef(false),
    generation = useRef(0);
  const permitted = options.readOnly ? owner.readable : access.allowed;
  useLayoutEffect(() => {
    generation.current++;
  }, [permitted]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  type Submission = { value: V; generation: number; completion?: ActionCompletion };
  const current = (input: Submission) =>
    owner.isCurrent() && mounted.current && permitted && generation.current === input.generation;
  const mutation = useMutationFeedback<Submission, R>({
    observation: false, // The domain acknowledgment below precedes independent refreshes.
    gcTime: 0,
    ownsResult: current,
    mutate: async (input) => {
      assertFeatureRead(owner);
      if (!options.readOnly) access.assertCurrent();
      if (!current(input))
        throw new AppError("화면 또는 설정 변경 권한이 바뀌었습니다.", { kind: "aborted" });
      let result: R;
      try {
        result = await options.mutate(input.value);
      } catch (cause) {
        if (current(input)) input.completion?.failure(cause);
        throw cause;
      }
      if (current(input)) {
        try {
          const error = options.observationError?.(result);
          if (error === undefined) input.completion?.success();
          else input.completion?.failure(error);
        } catch {
          /* Observation cannot change a product result. */
        }
      }
      // A completed write may outlive a tab. Refresh only the original readable
      // workspace; callbacks and downloads still require the initiating view.
      if (owner.isCurrent())
        await Promise.all(
          (options.invalidates ?? []).map((key) =>
            client.invalidateQueries({ queryKey: featureOwnedKey(key, owner) }),
          ),
        );
      return result;
    },
    errorMessage: options.errorMessage,
    successMessage: options.successMessage,
    onSuccess: (result, input) => options.onSuccess?.(result, input.value),
  });
  const submit = (value: V): Submission => ({
    value,
    generation: generation.current,
    completion: captureAction(options.observation, value),
  });
  return {
    ...mutation,
    variables: mutation.variables?.value,
    mutate: (value: V) => mutation.mutate(submit(value)),
    mutateAsync: (value: V) => mutation.mutateAsync(submit(value)),
  };
}
