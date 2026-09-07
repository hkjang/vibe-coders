import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";

const routeId = "access.users";
const access = endpoints.domains.access;

/** Query keys used by the access screens; mutations invalidate by prefix. */
export const accessKeys = {
  users: ["access", "users"] as const,
  usersBenchmark: ["access", "users", "benchmark"] as const,
  teams: ["access", "teams"] as const,
  teamsBenchmark: ["access", "teams", "benchmark"] as const,
  teamsScorecard: ["access", "teams", "scorecard"] as const,
  ips: ["access", "ips"] as const,
  quotas: ["access", "quotas"] as const,
  budgets: ["access", "budgets"] as const,
  budgetAlerts: ["access", "budgets", "alerts"] as const,
  apiKeys: ["access", "api-keys"] as const,
  roles: ["access", "roles"] as const,
};

function useAccessQuery<Result>(
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

export function useUsersQuery(enabled = true) {
  return useAccessQuery(
    accessKeys.users,
    (signal) => apiClient.request(access.users.list, { signal, routeId }),
    enabled,
  );
}

export function useUserBenchmarkQuery(window: string, enabled: boolean) {
  return useAccessQuery(
    [...accessKeys.usersBenchmark, window],
    (signal) => apiClient.request(access.users.benchmark, { query: { window, limit: 50 }, signal, routeId }),
    enabled,
  );
}

export function useTeamsQuery(enabled = true) {
  return useAccessQuery(
    accessKeys.teams,
    (signal) => apiClient.request(access.teams.list, { signal, routeId }),
    enabled,
  );
}

export function useTeamBenchmarkQuery(window: string, enabled: boolean) {
  return useAccessQuery(
    [...accessKeys.teamsBenchmark, window],
    (signal) => apiClient.request(access.teams.benchmark, { query: { window }, signal, routeId }),
    enabled,
  );
}

export function useTeamScorecardQuery(window: string, enabled: boolean) {
  return useAccessQuery(
    [...accessKeys.teamsScorecard, window],
    (signal) => apiClient.request(access.teams.scorecard, { query: { window }, signal, routeId }),
    enabled,
  );
}

export function useIpsQuery(enabled: boolean) {
  return useAccessQuery(
    accessKeys.ips,
    (signal) => apiClient.request(access.ips.list, { signal, routeId }),
    enabled,
  );
}

export function useQuotasQuery(enabled: boolean) {
  return useAccessQuery(
    accessKeys.quotas,
    (signal) => apiClient.request(access.quotas.list, { signal, routeId }),
    enabled,
  );
}

export function useBudgetsQuery(enabled: boolean) {
  return useAccessQuery(
    accessKeys.budgets,
    (signal) => apiClient.request(access.budgets.list, { signal, routeId }),
    enabled,
  );
}

export function useApiKeysQuery(enabled: boolean) {
  return useAccessQuery(
    accessKeys.apiKeys,
    (signal) => apiClient.request(access.apiKeys.list, { signal, routeId }),
    enabled,
  );
}

export function useRolesQuery(enabled: boolean) {
  return useAccessQuery(
    accessKeys.roles,
    (signal) => apiClient.request(access.roles.list, { signal, routeId }),
    enabled,
  );
}
