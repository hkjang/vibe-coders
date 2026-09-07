import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/shared/api/client";
import type { ModelContractWriteBody, ModelDeprecationWriteBody } from "@/shared/api/domains/gateway";
import { withGatewayPathParams } from "@/shared/api/domains/gateway";
import { endpoints } from "@/shared/api/endpoints";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";

const routeId = "gateway.models";
const gateway = endpoints.domains.gateway;

export const modelGovernanceKeys = {
  contracts: ["gateway", "models", "contracts"] as const,
  deprecations: ["gateway", "models", "deprecations"] as const,
};

export function useModelContracts() {
  return useQuery({
    queryKey: modelGovernanceKeys.contracts,
    queryFn: ({ signal }) => apiClient.request(gateway.models.contracts.list, { signal, routeId }),
  });
}

export function useModelDeprecations() {
  return useQuery({
    queryKey: modelGovernanceKeys.deprecations,
    queryFn: ({ signal }) => apiClient.request(gateway.models.deprecations.list, { signal, routeId }),
  });
}

export function useModelGovernanceMutations() {
  const saveContract = useMutationFeedback({
    mutate: (body: ModelContractWriteBody) =>
      apiClient.request(gateway.models.contracts.save, { body, routeId }),
    invalidates: [modelGovernanceKeys.contracts],
    successMessage: "모델 계약을 저장했습니다.",
    errorMessage: "모델 계약을 저장하지 못했습니다.",
  });

  const removeContract = useMutationFeedback({
    mutate: (id: string) => apiClient.request(gateway.models.contracts.remove, { query: { id }, routeId }),
    invalidates: [modelGovernanceKeys.contracts],
    successMessage: "모델 계약을 삭제했습니다.",
    errorMessage: "모델 계약을 삭제하지 못했습니다.",
  });

  const runContract = useMutationFeedback({
    mutate: (input: { model: string; contract_id?: string }) =>
      apiClient.request(gateway.models.contracts.run, { body: input, routeId }),
    successMessage: "계약 검증을 실행했습니다.",
    errorMessage: "계약 검증을 실행하지 못했습니다.",
  });

  const saveDeprecation = useMutationFeedback({
    mutate: (body: ModelDeprecationWriteBody) =>
      apiClient.request(gateway.models.deprecations.save, { body, routeId }),
    invalidates: [modelGovernanceKeys.deprecations, ["admin", "models"]],
    successMessage: "지원 종료 정책을 저장했습니다.",
    errorMessage: "지원 종료 정책을 저장하지 못했습니다.",
  });

  const removeDeprecation = useMutationFeedback({
    mutate: (id: string) =>
      apiClient.request(withGatewayPathParams(gateway.models.deprecations.remove, { id }), { routeId }),
    invalidates: [modelGovernanceKeys.deprecations, ["admin", "models"]],
    successMessage: "지원 종료 정책을 삭제했습니다.",
    errorMessage: "지원 종료 정책을 삭제하지 못했습니다.",
  });

  return { removeContract, removeDeprecation, runContract, saveContract, saveDeprecation } as const;
}
