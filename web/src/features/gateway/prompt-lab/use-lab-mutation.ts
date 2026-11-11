import { useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppError, isAppError } from "@/shared/api/error";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { assertFeatureRead, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { safeLabError } from "./prompt-lab-model";

const flights = new WeakMap<QueryClient, Set<string>>();
export function useLabAccess() {
  const auth = useAuth();
  return useFeatureMutationAccess(
    ["prompts.lab"],
    auth.user?.scopes.includes("admin:write") ?? false,
    "이 작업은 admin:write 권한과 프롬프트 실험실의 편집 허용 설정이 필요합니다.",
  );
}
interface Options<V, R> {
  prepare?: (value: V) => Promise<void>;
  mutate: (value: V) => Promise<R>;
  validate?: (result: R, value: V) => void;
  invalidates: readonly QueryKey[] | ((value: V) => readonly QueryKey[]);
  successMessage: string | ((result: R, value: V) => string);
  errorMessage: string;
  onSuccess?: (result: R, value: V) => void;
}
export function useLabMutation<V, R>(owner: FeatureReadOwner, options: Options<V, R>) {
  const auth = useAuth();
  const access = useLabAccess();
  const client = useQueryClient();
  const mounted = useRef(false);
  const revision = useRef(0);
  const [uncertain, setUncertain] = useState(false);
  useLayoutEffect(() => {
    revision.current++;
  }, [access.allowed]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const mutation = useMutation({
    retry: false,
    gcTime: 0,
    mutationFn: async (value: V) => {
      const generation = revision.current;
      const assertCurrent = () => {
        assertFeatureRead(owner);
        access.assertCurrent();
        if (!mounted.current || revision.current !== generation)
          throw new AppError("화면 또는 작업 권한이 변경됐습니다.", { kind: "aborted" });
      };
      assertCurrent();
      if (uncertain)
        throw new AppError("이전 작업의 결과를 확인한 뒤 새 작업을 시작하세요.", {
          kind: "contract",
          code: "prompt_lab_unknown",
        });
      const principal = JSON.stringify([auth.mode, auth.user?.id, auth.user?.team_id]);
      let pending = flights.get(client);
      if (!pending) {
        pending = new Set();
        flights.set(client, pending);
      }
      if (pending.has(principal))
        throw new AppError("진행 중인 실험실 작업이 있습니다.", {
          kind: "contract",
          code: "prompt_lab_busy",
        });
      pending.add(principal);
      let sent = false,
        acknowledged = false;
      try {
        await options.prepare?.(value);
        assertCurrent();
        sent = true;
        const result = await options.mutate(value);
        acknowledged = true;
        options.validate?.(result, value);
        assertCurrent();
        const keys =
          typeof options.invalidates === "function" ? options.invalidates(value) : options.invalidates;
        await Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })));
        assertCurrent();
        toast.success(
          typeof options.successMessage === "function"
            ? options.successMessage(result, value)
            : options.successMessage,
        );
        options.onSuccess?.(result, value);
        // Creation responses may echo stored inputs. Keep only the projected run
        // receipt in the caller; do not retain response bodies in Mutation cache.
        return;
      } catch (error) {
        const knownRejection =
          isAppError(error) && error.status !== undefined && error.status >= 400 && error.status < 500;
        if (sent && (!knownRejection || acknowledged) && mounted.current && owner.isCurrent())
          setUncertain(true);
        throw safeLabError(error, auth.credentialPrefixes);
      } finally {
        pending.delete(principal);
      }
    },
  });
  return { ...mutation, uncertain };
}
