import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";

const routeId = "gateway.health";
const gateway = endpoints.domains.gateway;
const routingHealthKey = ["admin", "routing", "health"];
const balancerKey = ["gateway", "routing", "balancer"];

export function useBalancerState(enabled: boolean, window: string) {
  return useQuery({
    queryKey: [...balancerKey, window],
    queryFn: ({ signal }) =>
      apiClient.request(gateway.routing.balancer, { query: { window }, signal, routeId }),
    enabled,
  });
}

/**
 * Recovery actions the legacy Provider Health tab offered: clearing a tripped
 * circuit breaker and releasing sticky sessions. An empty provider means "all".
 */
export function useHealthActions() {
  const resetBreaker = useMutationFeedback({
    mutate: (provider: string) =>
      apiClient.request(gateway.routing.breakerReset, { body: { provider }, routeId }),
    invalidates: [routingHealthKey],
    successMessage: (_result, provider) =>
      provider === "" ? "모든 회로 차단기를 해제했습니다." : "회로 차단기를 해제했습니다.",
    errorMessage: "회로 차단기를 해제하지 못했습니다.",
  });

  const releaseSessions = useMutationFeedback({
    mutate: (provider: string) =>
      apiClient.request(gateway.routing.releaseSessions, { body: { provider }, routeId }),
    invalidates: [balancerKey, routingHealthKey],
    successMessage: "세션 고정을 해제했습니다.",
    errorMessage: "세션 고정을 해제하지 못했습니다.",
  });

  return { releaseSessions, resetBreaker } as const;
}
