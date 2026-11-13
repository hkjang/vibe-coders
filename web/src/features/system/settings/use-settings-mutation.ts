import { useLayoutEffect, useRef } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { AppError } from "@/shared/api/error";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { assertFeatureRead, featureOwnedKey } from "@/shared/hooks/use-feature-read-owner";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useSettingsWorkspace } from "./settings-workspace-context";

export function useSettingsWriteAccess(authorized = true) {
  return useFeatureMutationAccess(
    ["system.settings"],
    authorized,
    "이 작업에 필요한 설정 변경 권한이 없습니다.",
  );
}
interface Options<V, R> {
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
  type Submission = { value: V; generation: number };
  const current = (input: Submission) =>
    owner.isCurrent() && mounted.current && permitted && generation.current === input.generation;
  const mutation = useMutationFeedback<Submission, R>({
    gcTime: 0,
    ownsResult: current,
    mutate: async (input) => {
      assertFeatureRead(owner);
      if (!options.readOnly) access.assertCurrent();
      if (!current(input))
        throw new AppError("화면 또는 설정 변경 권한이 바뀌었습니다.", { kind: "aborted" });
      const result = await options.mutate(input.value);
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
  return {
    ...mutation,
    variables: mutation.variables?.value,
    mutate: (value: V) => mutation.mutate({ value, generation: generation.current }),
    mutateAsync: (value: V) => mutation.mutateAsync({ value, generation: generation.current }),
  };
}
