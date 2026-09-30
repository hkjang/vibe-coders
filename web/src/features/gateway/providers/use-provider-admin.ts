import { apiClient } from "@/shared/api/client";
import type { ProviderSLOWriteBody, ProviderWriteBody } from "@/shared/api/domains/gateway";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useProviderWriteAccess } from "./use-provider-write-access";

const routeId = "gateway.providers";
const providerKey = ["admin", "providers"];
const sloKey = ["admin", "providers", "slo"];
const routingKey = ["admin", "routing", "health"];

const gateway = endpoints.domains.gateway;

/**
 * Provider upserts require the raw public name. Delete and SLO operations also
 * accept an opaque provider reference, resolved by the existing server handlers.
 */
export function useProviderAdmin() {
  const access = useProviderWriteAccess();
  const save = useMutationFeedback({
    mutate: (body: ProviderWriteBody) => {
      access.assertCurrent();
      return apiClient.request(gateway.providers.save, { body, routeId });
    },
    invalidates: [providerKey, routingKey],
    successMessage: "공급자 설정을 저장했습니다.",
    errorMessage: "공급자 설정을 저장하지 못했습니다.",
  });

  const remove = useMutationFeedback({
    mutate: (name: string) => {
      access.assertCurrent();
      return apiClient.request(withPathParams(gateway.providers.remove, { name }), { routeId });
    },
    invalidates: [providerKey, sloKey, routingKey],
    successMessage: "공급자를 삭제했습니다.",
    errorMessage: "공급자를 삭제하지 못했습니다.",
  });

  const saveSlo = useMutationFeedback({
    mutate: (body: ProviderSLOWriteBody) => {
      access.assertCurrent();
      return apiClient.request(gateway.providers.saveSlo, { body, routeId });
    },
    invalidates: [sloKey],
    successMessage: "공급자 서비스 목표를 저장했습니다.",
    errorMessage: "공급자 서비스 목표를 저장하지 못했습니다.",
  });

  const removeSlo = useMutationFeedback({
    mutate: (provider: string) => {
      access.assertCurrent();
      return apiClient.request(gateway.providers.removeSlo, { query: { provider }, routeId });
    },
    invalidates: [sloKey],
    successMessage: "공급자 서비스 목표를 삭제했습니다.",
    errorMessage: "공급자 서비스 목표를 삭제하지 못했습니다.",
  });

  return { access, remove, removeSlo, save, saveSlo } as const;
}
