import { apiClient } from "@/shared/api/client";
import type { ProviderSLOWriteBody, ProviderWriteBody } from "@/shared/api/domains/gateway";
import { withGatewayPathParams } from "@/shared/api/domains/gateway";
import { endpoints } from "@/shared/api/endpoints";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";

const routeId = "gateway.providers";
const providerKey = ["admin", "providers"];
const sloKey = ["admin", "providers", "slo"];
const routingKey = ["admin", "routing", "health"];

const gateway = endpoints.domains.gateway;

/**
 * Provider administration mutations. Writes go out under the raw provider name, so
 * callers must first check that the name was not redacted by the server projection.
 */
export function useProviderAdmin() {
  const save = useMutationFeedback({
    mutate: (body: ProviderWriteBody) => apiClient.request(gateway.providers.save, { body, routeId }),
    invalidates: [providerKey, routingKey],
    successMessage: "공급자 설정을 저장했습니다.",
    errorMessage: "공급자 설정을 저장하지 못했습니다.",
  });

  const remove = useMutationFeedback({
    mutate: (name: string) =>
      apiClient.request(withGatewayPathParams(gateway.providers.remove, { name }), { routeId }),
    invalidates: [providerKey, sloKey, routingKey],
    successMessage: "공급자를 삭제했습니다.",
    errorMessage: "공급자를 삭제하지 못했습니다.",
  });

  const saveSlo = useMutationFeedback({
    mutate: (body: ProviderSLOWriteBody) => apiClient.request(gateway.providers.saveSlo, { body, routeId }),
    invalidates: [sloKey],
    successMessage: "공급자 SLO를 저장했습니다.",
    errorMessage: "공급자 SLO를 저장하지 못했습니다.",
  });

  const removeSlo = useMutationFeedback({
    mutate: (provider: string) =>
      apiClient.request(gateway.providers.removeSlo, { query: { provider }, routeId }),
    invalidates: [sloKey],
    successMessage: "공급자 SLO를 삭제했습니다.",
    errorMessage: "공급자 SLO를 삭제하지 못했습니다.",
  });

  return { remove, removeSlo, save, saveSlo } as const;
}
