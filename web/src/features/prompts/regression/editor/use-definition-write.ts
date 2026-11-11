import { useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/app/auth/AuthProvider";
import { isAppError } from "@/shared/api/error";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { regressionId } from "../regression-model";
import { type DefinitionTarget, type DefinitionValues } from "./definition-form";
import { definitionError } from "./definition-messages";
import {
  confirmDefinition,
  currentDefinition,
  safeDefinitionError,
  saveDefinition,
} from "./definition-write";

const flights = new WeakMap<QueryClient, Set<string>>();
export function useDefinitionAccess() {
  const auth = useAuth();
  return useFeatureMutationAccess(
    [regressionId],
    auth.user?.scopes.includes("admin:write") ?? false,
    "정의를 변경하려면 admin:write 권한과 기능의 편집 허용 설정이 필요합니다.",
  );
}
export function useDefinitionWrite(owner: FeatureReadOwner, target: DefinitionTarget) {
  const auth = useAuth();
  const access = useDefinitionAccess();
  const client = useQueryClient();
  const revision = useRef(0);
  const mounted = useRef(false);
  const [uncertain, setUncertain] = useState<DefinitionValues>();
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
    mutationFn: async (values: DefinitionValues) => {
      const generation = revision.current;
      const assertCurrent = () => {
        assertFeatureRead(owner);
        access.assertCurrent();
        if (!mounted.current || revision.current !== generation) throw definitionError("golden_owner");
      };
      assertCurrent();
      const principal = JSON.stringify([auth.mode, auth.user?.id, auth.user?.team_id]);
      let pending = flights.get(client);
      if (!pending) {
        pending = new Set();
        flights.set(client, pending);
      }
      if (pending.has(principal)) throw definitionError("golden_busy");
      pending.add(principal);
      let acknowledged = false;
      const read = async (selected: DefinitionTarget) => {
        let latest: DefinitionTarget | undefined;
        // The owned query propagates GET 401/403 and cancellation to the read
        // boundary. Cache only a boolean; raw definitions stay in this flight.
        await client.fetchQuery({
          queryKey: featureOwnedKey([regressionId, "definition-check", selected.kind, selected.id], owner),
          staleTime: 0,
          gcTime: 0,
          retry: false,
          queryFn: async ({ signal }) => {
            try {
              assertFeatureRead(owner, signal);
              latest = await currentDefinition(selected, signal);
              assertFeatureRead(owner, signal);
              return true;
            } catch (error) {
              throw safeDefinitionError(error, auth.credentialPrefixes);
            }
          },
        });
        assertCurrent();
        if (!latest) throw definitionError("golden_owner");
        return latest;
      };
      try {
        if (uncertain) await confirmDefinition(target, uncertain, assertCurrent, read);
        else await saveDefinition(target, values, assertCurrent, read);
        acknowledged = true;
        assertCurrent();
        await client.invalidateQueries({
          predicate: ({ queryKey }) =>
            queryKey[0] === regressionId &&
            queryKey[1] === (target.kind === "prompt" ? "prompts" : "workflows") &&
            queryKey.at(-2) === owner.marker &&
            queryKey.at(-1) === owner.id,
        });
        assertCurrent();
        toast.success(
          uncertain ? "현재 저장된 정의가 전송한 내용과 일치합니다." : "회귀 검증 정의를 저장했습니다.",
        );
      } catch (error) {
        if (
          mounted.current &&
          owner.isCurrent() &&
          (acknowledged || (isAppError(error) && error.code === "golden_unknown"))
        )
          setUncertain(values);
        throw safeDefinitionError(error, auth.credentialPrefixes);
      } finally {
        pending.delete(principal);
      }
    },
  });
  return { ...access, uncertain: uncertain !== undefined, submit: mutation.mutateAsync };
}
