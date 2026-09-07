import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";

const access = endpoints.domains.access;
const routeId = "me.home";

export const meKeys = {
  all: ["me"] as const,
  dashboard: ["me", "dashboard"] as const,
  actions: ["me", "actions"] as const,
  report: ["me", "report"] as const,
  notifications: ["me", "notifications"] as const,
  recommendedModels: ["me", "recommended-models"] as const,
  requests: ["me", "requests"] as const,
  skills: ["me", "skills"] as const,
  sessions: ["me", "sessions"] as const,
  recommendations: ["me", "recommendations"] as const,
  keys: ["me", "keys"] as const,
  onboarding: ["me", "onboarding-pack"] as const,
};

function useMeQuery<Result>(
  queryKey: readonly unknown[],
  run: (signal: AbortSignal) => Promise<Result>,
  enabled = true,
): UseQueryResult<Result> {
  const refetchInterval = useRefreshInterval();
  return useQuery({
    queryKey,
    queryFn: ({ signal }) => run(signal),
    enabled,
    refetchInterval,
    refetchIntervalInBackground: false,
  });
}

export function useMeDashboardQuery() {
  return useMeQuery(meKeys.dashboard, (signal) =>
    apiClient.request(access.me.dashboard, { signal, routeId }),
  );
}

export function useMeActionsQuery() {
  return useMeQuery(meKeys.actions, (signal) => apiClient.request(access.me.actions, { signal, routeId }));
}

export function useMeReportQuery(window: "weekly" | "monthly") {
  return useMeQuery([...meKeys.report, window], (signal) =>
    apiClient.request(access.me.report, { query: { window }, signal, routeId }),
  );
}

export function useMeNotificationsQuery() {
  return useMeQuery(meKeys.notifications, (signal) =>
    apiClient.request(access.me.notifications, { signal, routeId }),
  );
}

export function useMeRecommendedModelsQuery(enabled: boolean) {
  return useMeQuery(
    meKeys.recommendedModels,
    (signal) => apiClient.request(access.me.recommendedModels, { signal, routeId }),
    enabled,
  );
}

export function useMeRequestsQuery(limit: number, enabled: boolean) {
  return useMeQuery(
    [...meKeys.requests, limit],
    (signal) => apiClient.request(access.me.requests, { query: { limit }, signal, routeId }),
    enabled,
  );
}

export function useMeSkillsQuery(enabled: boolean) {
  return useMeQuery(
    meKeys.skills,
    (signal) => apiClient.request(access.me.skills, { signal, routeId }),
    enabled,
  );
}

export function useMeSessionsQuery(enabled: boolean) {
  return useMeQuery(
    meKeys.sessions,
    (signal) => apiClient.request(access.me.sessions, { signal, routeId }),
    enabled,
  );
}

export function useMeKeysQuery(enabled: boolean) {
  return useMeQuery(meKeys.keys, (signal) => apiClient.request(access.me.keys, { signal, routeId }), enabled);
}

export function useMeOnboardingPackQuery(client: string, enabled: boolean) {
  return useMeQuery(
    [...meKeys.onboarding, client],
    (signal) => apiClient.request(access.me.onboardingPack, { query: { client }, signal, routeId }),
    enabled,
  );
}
