import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/shared/api/client";
import { withGatewayPathParams } from "@/shared/api/domains/gateway";
import { endpoints } from "@/shared/api/endpoints";

export const promptLabRouteId = "prompts.lab";

const lab = endpoints.domains.gateway.promptLab;

export const promptLabKeys = {
  experiments: ["gateway", "prompt-lab", "experiments"] as const,
  contracts: ["gateway", "prompt-lab", "contracts"] as const,
  rubrics: ["gateway", "prompt-lab", "rubrics"] as const,
  experiment: (id: string) => ["gateway", "prompt-lab", "experiment", id] as const,
};

export function usePromptExperiments() {
  return useQuery({
    queryKey: promptLabKeys.experiments,
    queryFn: ({ signal }) => apiClient.request(lab.experiments.list, { signal, routeId: promptLabRouteId }),
  });
}

export function usePromptContracts() {
  return useQuery({
    queryKey: promptLabKeys.contracts,
    queryFn: ({ signal }) => apiClient.request(lab.contracts.list, { signal, routeId: promptLabRouteId }),
  });
}

export function usePromptRubrics() {
  return useQuery({
    queryKey: promptLabKeys.rubrics,
    queryFn: ({ signal }) => apiClient.request(lab.rubrics.list, { signal, routeId: promptLabRouteId }),
  });
}

export function usePromptExperimentDetail(id: string) {
  return useQuery({
    queryKey: promptLabKeys.experiment(id),
    queryFn: ({ signal }) =>
      apiClient.request(withGatewayPathParams(lab.experiments.detail, { id }), {
        signal,
        routeId: promptLabRouteId,
      }),
    enabled: id !== "",
  });
}
