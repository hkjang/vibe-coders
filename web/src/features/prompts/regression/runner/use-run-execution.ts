import { useLayoutEffect, useRef, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError, isAppError } from "@/shared/api/error";
import { assertFeatureRead, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { regressionId } from "../regression-model";
import { safeDefinitionError } from "../editor/definition-write";
import { useDefinitionAccess } from "../editor/use-definition-write";
import { projectRunReceipt, runError, validateRunReceipt, type RunPlan, type RunReceipt } from "./run-model";

const flights = new WeakMap<QueryClient, Set<string>>();
export function useRunExecution(owner: FeatureReadOwner) {
  const auth = useAuth();
  const access = useDefinitionAccess();
  const client = useQueryClient();
  const revision = useRef(0);
  const mounted = useRef(false);
  const [uncertain, setUncertain] = useState(false);
  const uncertainNow = useRef(false);
  useLayoutEffect(() => {
    revision.current++;
  }, [access.allowed]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return {
    ...access,
    uncertain,
    execute: async (plan: RunPlan): Promise<RunReceipt> => {
      const generation = revision.current;
      const assertCurrent = () => {
        assertFeatureRead(owner);
        access.assertCurrent();
        if (!mounted.current || revision.current !== generation) throw runError("golden_run_owner");
      };
      assertCurrent();
      if (uncertainNow.current) throw runError("golden_run_unknown");
      const principal = JSON.stringify([auth.mode, auth.user?.id, auth.user?.team_id]);
      let pending = flights.get(client);
      if (!pending) {
        pending = new Set();
        flights.set(client, pending);
      }
      if (pending.has(principal)) throw runError("golden_run_busy");
      pending.add(principal);
      let dispatched = false;
      try {
        assertCurrent();
        dispatched = true;
        const review = {
          definitions: plan.definitions,
          max_calls: plan.values.maxCalls,
          max_output_tokens: plan.values.outputTokens,
        };
        const common = { models: plan.values.models, min_pass_rate: plan.values.passRate, review };
        const options = { routeId: regressionId, retryUnauthorized: false, timeoutMs: 150_000 } as const;
        const receipt: RunReceipt =
          plan.kind === "prompt"
            ? {
                kind: "prompt",
                plan,
                receivedAt: Date.now(),
                result: await apiClient.request(endpoints.domains.prompts.golden.runPrompts, {
                  ...options,
                  body: { ...common, prompt_ids: plan.values.ids },
                }),
              }
            : {
                kind: "workflow",
                plan,
                receivedAt: Date.now(),
                result: await apiClient.request(endpoints.domains.prompts.golden.runWorkflow, {
                  ...options,
                  body: { ...common, id: plan.values.ids[0] ?? "" },
                }),
              };
        assertCurrent();
        validateRunReceipt(plan, receipt.result);
        const projected = projectRunReceipt({ ...receipt, receivedAt: Date.now() }, auth.credentialPrefixes);
        // A receipt is independent of a later history refresh. Never let a failed
        // refresh turn an acknowledged run into a suggestion to execute it again.
        if (plan.kind === "prompt")
          void client.invalidateQueries({
            predicate: ({ queryKey }) =>
              queryKey[0] === regressionId &&
              queryKey[1] === "prompts" &&
              queryKey.at(-2) === owner.marker &&
              queryKey.at(-1) === owner.id,
          });
        assertCurrent();
        return projected;
      } catch (error) {
        const rejected = isAppError(error) && [400, 401, 403, 404, 405, 409, 413].includes(error.status ?? 0);
        if (dispatched && !rejected) {
          uncertainNow.current = true;
          if (mounted.current && owner.isCurrent()) setUncertain(true);
          const safe = safeDefinitionError(error, auth.credentialPrefixes);
          throw new AppError("실행 결과 확인 필요", {
            kind: "permission",
            code: "golden_run_unknown",
            requestId: safe.requestId,
          });
        }
        throw safeDefinitionError(error, auth.credentialPrefixes);
      } finally {
        pending.delete(principal);
      }
    },
  };
}
