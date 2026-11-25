import { useLayoutEffect, useRef } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppError, isAppError } from "@/shared/api/error";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { assertFeatureRead, useFeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { containsPotentialSecret } from "@/shared/security/secrets";

type Options<V, R> = Omit<Parameters<typeof useMutationFeedback<V, R>>[0], "mutate"> & {
  mutate: (value: V, assertCurrent: () => void) => Promise<R>;
  authorized?: boolean;
  readOnly?: boolean;
};

/** Bind writes and explicit reads to the initiating view and current authority. */
export function useText2SqlMutation<V = void, R = unknown>(options: Options<V, R>) {
  const auth = useAuth();
  const owner = useFeatureReadOwner("text2sql.overview", "text2sql-action");
  const access = useFeatureMutationAccess(
    ["text2sql.overview"],
    (options.authorized ?? true) && (auth.user?.scopes.includes("admin:write") ?? false),
  );
  const permitted = owner.readable && (options.readOnly || access.allowed);
  const latest = useRef({ permitted, generation: 0 });
  const inFlight = useRef(false);
  useLayoutEffect(() => {
    latest.current = { permitted, generation: latest.current.generation + 1 };
  }, [permitted]);
  type Submission = { value: V; generation: number };
  const current = (input: Submission) =>
    owner.isCurrent() &&
    Boolean(latest.current.permitted) &&
    input.generation === latest.current.generation &&
    (options.ownsResult?.(input.value) ?? true);
  const mutation = useMutationFeedback<Submission, R>({
    ...options,
    observation: (input) =>
      typeof options.observation === "function" ? options.observation(input.value) : options.observation,
    gcTime: 0,
    ownsResult: current,
    mutate: async (input) => {
      const assertCurrent = () => {
        assertFeatureRead(owner);
        if (!options.readOnly) access.assertCurrent();
        if (!current(input)) throw new AppError("현재 화면과 권한을 다시 확인하세요.", { kind: "aborted" });
      };
      assertCurrent();
      try {
        return await options.mutate(input.value, assertCurrent);
      } catch (error) {
        if (!isAppError(error)) throw error;
        throw new AppError(safeAppErrorMessage(error, "작업을 완료하지 못했습니다."), {
          kind: error.kind,
          status: error.status,
          code: error.code,
          requestId:
            error.requestId &&
            error.requestId.length <= 200 &&
            !containsPotentialSecret(error.requestId, auth.credentialPrefixes)
              ? error.requestId
              : undefined,
        });
      }
    },
    successMessage: options.successMessage
      ? (result, input) => {
          const message =
            typeof options.successMessage === "function"
              ? options.successMessage(result, input.value)
              : options.successMessage;
          return message && !containsPotentialSecret(message, auth.credentialPrefixes)
            ? message
            : "작업을 완료했습니다.";
        }
      : undefined,
    onSuccess: (result, input) => options.onSuccess?.(result, input.value),
  });
  const submit = async (value: V): Promise<R> => {
    if (inFlight.current) throw new AppError("이미 처리 중인 작업입니다.", { kind: "aborted" });
    inFlight.current = true;
    try {
      return await mutation.mutateAsync({ value, generation: latest.current.generation });
    } finally {
      inFlight.current = false;
    }
  };
  return {
    ...mutation,
    variables: mutation.variables?.value,
    mutate: (value: V) => {
      void submit(value).catch(() => undefined);
    },
    mutateAsync: submit,
  };
}
