import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";

export const chatRouteId = "gateway.chat";

const gateway = endpoints.domains.gateway;

export function useChatTargets() {
  return useQuery({
    queryKey: ["gateway", "chat", "targets"],
    queryFn: ({ signal }) => apiClient.request(gateway.chat.targets, { signal, routeId: chatRouteId }),
    staleTime: 30_000,
  });
}

export function useModelUsageTags() {
  return useQuery({
    queryKey: ["admin", "model-tags"],
    queryFn: ({ signal }) => apiClient.request(endpoints.admin.models.tags, { signal, routeId: chatRouteId }),
  });
}

export function useMultiRunHistory(enabled: boolean) {
  return useQuery({
    queryKey: ["gateway", "chat", "multi-runs"],
    queryFn: ({ signal }) =>
      apiClient.request(gateway.chat.multiRuns, {
        query: { limit: 20 },
        signal,
        routeId: chatRouteId,
      }),
    enabled,
  });
}

export function useJudgeLeaderboard(enabled: boolean, days = 90) {
  return useQuery({
    queryKey: ["gateway", "chat", "leaderboard", days],
    queryFn: ({ signal }) =>
      apiClient.request(gateway.chat.leaderboard, { query: { days }, signal, routeId: chatRouteId }),
    enabled,
  });
}

export function useCodeVerifyStats(enabled: boolean, days = 30) {
  return useQuery({
    queryKey: ["gateway", "chat", "code-verify-stats", days],
    queryFn: ({ signal }) =>
      apiClient.request(gateway.chat.codeVerifyStats, { query: { days }, signal, routeId: chatRouteId }),
    enabled,
  });
}
