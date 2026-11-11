import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/shared/api/client";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { useAuth } from "@/app/auth/AuthProvider";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import {
  projectExperiment,
  projectContract,
  projectRubric,
  projectCase,
  projectHistory,
  labIDAllowed,
  labError,
  safeLabError,
} from "./prompt-lab-model";

export const promptLabRouteId = "prompts.lab";

const lab = endpoints.domains.gateway.promptLab;

export const promptLabKeys = {
  experiments: ["gateway", "prompt-lab", "experiments"] as const,
  contracts: ["gateway", "prompt-lab", "contracts"] as const,
  rubrics: ["gateway", "prompt-lab", "rubrics"] as const,
  experiment: (id: string) => ["gateway", "prompt-lab", "experiment", id] as const,
  history: (id: string) => ["gateway", "prompt-lab", "history", id] as const,
};

export function usePromptExperiments(owner: FeatureReadOwner) {
  const { credentialPrefixes } = useAuth();
  return useQuery({
    queryKey: featureOwnedKey(promptLabKeys.experiments, owner),
    gcTime: 0,
    retry: false,
    queryFn: ({ signal }) =>
      owned(owner, signal, credentialPrefixes, async () => {
        const data = await apiClient.request(lab.experiments.list, {
          signal,
          routeId: promptLabRouteId,
          cache: "no-store",
        });
        return { experiments: data.experiments.map((row) => projectExperiment(row, credentialPrefixes)) };
      }),
  });
}

export function usePromptContracts(owner: FeatureReadOwner) {
  const { credentialPrefixes } = useAuth();
  return useQuery({
    queryKey: featureOwnedKey(promptLabKeys.contracts, owner),
    gcTime: 0,
    retry: false,
    queryFn: ({ signal }) =>
      owned(owner, signal, credentialPrefixes, async () => {
        const data = await apiClient.request(lab.contracts.list, {
          signal,
          routeId: promptLabRouteId,
          cache: "no-store",
        });
        return { contracts: data.contracts.map((row) => projectContract(row, credentialPrefixes)) };
      }),
  });
}

export function usePromptRubrics(owner: FeatureReadOwner) {
  const { credentialPrefixes } = useAuth();
  return useQuery({
    queryKey: featureOwnedKey(promptLabKeys.rubrics, owner),
    gcTime: 0,
    retry: false,
    queryFn: ({ signal }) =>
      owned(owner, signal, credentialPrefixes, async () => {
        const data = await apiClient.request(lab.rubrics.list, {
          signal,
          routeId: promptLabRouteId,
          cache: "no-store",
        });
        return { rubrics: data.rubrics.map((row) => projectRubric(row, credentialPrefixes)) };
      }),
  });
}

export function usePromptExperimentDetail(owner: FeatureReadOwner, id: string) {
  const { credentialPrefixes } = useAuth();
  return useQuery({
    queryKey: featureOwnedKey(promptLabKeys.experiment(id), owner),
    gcTime: 0,
    retry: false,
    queryFn: ({ signal }) =>
      owned(owner, signal, credentialPrefixes, async () => {
        if (!labIDAllowed(id, credentialPrefixes)) throw labError("실험 식별자를 확인할 수 없습니다.");
        const data = await apiClient.request(withPathParams(lab.experiments.detail, { id }), {
          signal,
          routeId: promptLabRouteId,
          cache: "no-store",
        });
        if (data.experiment?.id !== id || data.test_cases.some((row) => row.experiment_id !== id))
          throw labError("선택한 실험과 조회 결과가 일치하지 않습니다.");
        return {
          experiment: projectExperiment(data.experiment, credentialPrefixes),
          test_cases: data.test_cases.map((row) => projectCase(row, credentialPrefixes)),
        };
      }),
    enabled: id !== "",
  });
}
export function usePromptCaseHistory(owner: FeatureReadOwner, experimentId: string, id: string) {
  const { credentialPrefixes } = useAuth();
  return useQuery({
    queryKey: featureOwnedKey([...promptLabKeys.history(id), experimentId], owner),
    gcTime: 0,
    staleTime: 0,
    retry: false,
    enabled: id !== "",
    queryFn: ({ signal }) =>
      owned(owner, signal, credentialPrefixes, async () => {
        if (!labIDAllowed(id, credentialPrefixes) || !labIDAllowed(experimentId, credentialPrefixes))
          throw labError("테스트 케이스 식별자를 확인할 수 없습니다.");
        const data = await apiClient.request(withPathParams(lab.testCases.detail, { id }), {
          signal,
          routeId: promptLabRouteId,
          cache: "no-store",
        });
        if (data.test_case?.id !== id || data.test_case.experiment_id !== experimentId)
          throw labError("선택한 테스트 케이스와 조회 결과가 일치하지 않습니다.");
        return {
          test_case: projectCase(data.test_case, credentialPrefixes),
          history: projectHistory(data.history, credentialPrefixes),
        };
      }),
  });
}
async function owned<T>(
  owner: FeatureReadOwner,
  signal: AbortSignal,
  prefixes: readonly string[],
  read: () => Promise<T>,
) {
  try {
    assertFeatureRead(owner, signal);
    const data = await read();
    assertFeatureRead(owner, signal);
    return data;
  } catch (error) {
    throw safeLabError(error, prefixes);
  }
}
