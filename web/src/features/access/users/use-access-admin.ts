import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { accountPageSchema, type AccountQuery } from "@/shared/api/domains/account-page.schemas";
import { AppError } from "@/shared/api/error";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";

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
  budgetProjection: ["access", "budgets", "projection"] as const,
  apiKeys: ["access", "api-keys"] as const,
  roles: ["access", "roles"] as const,
};

function useAccessQuery<Result>(
  queryKey: readonly unknown[],
  run: (signal: AbortSignal) => Promise<Result>,
  enabled = true,
  owner?: FeatureReadOwner,
): UseQueryResult<Result> {
  const refetchInterval = useRefreshInterval();
  return useQuery({
    queryKey: owner ? featureOwnedKey(queryKey, owner) : queryKey,
    queryFn: async ({ signal }) => {
      if (owner) assertFeatureRead(owner, signal);
      const result = await run(signal);
      if (owner) assertFeatureRead(owner, signal);
      return result;
    },
    enabled: enabled && (!owner || (owner.readable && !owner.denied)),
    gcTime: owner ? 0 : undefined,
    refetchInterval,
    refetchIntervalInBackground: false,
  });
}

export function useUsersQuery(enabled = true, owner?: FeatureReadOwner, usageOnly = false) {
  return useAccessQuery(
    usageOnly ? [...accessKeys.users, "usage"] : accessKeys.users,
    (signal) =>
      usageOnly
        ? apiClient.request(access.users.usage, { query: { view: "usage" }, signal, routeId })
        : apiClient.request(access.users.list, { signal, routeId }),
    enabled,
    owner,
  );
}

export function useAccountPageQuery(query: AccountQuery, owner: FeatureReadOwner) {
  return useAccessQuery(
    [...accessKeys.users, "accounts", query],
    async (signal) => {
      const parsed = accountPageSchema.safeParse(
        await apiClient.request(access.users.accounts, { query, signal, routeId }),
      );
      if (!parsed.success)
        throw new AppError("계정 목록의 형식을 확인하지 못했습니다. 다시 조회하세요.", { kind: "contract" });
      const result = parsed.data;
      if (
        result.limit !== query.limit ||
        result.offset !== query.offset ||
        result.accounts.length !== Math.min(query.limit, Math.max(0, result.total - query.offset)) ||
        new Set(result.accounts.map((row) => row.id)).size !== result.accounts.length
      )
        throw new AppError("계정 목록의 조회 범위를 확인하지 못했습니다. 다시 조회하세요.", {
          kind: "contract",
        });
      return result;
    },
    true,
    owner,
  );
}

export function useUserBenchmarkQuery(window: string, enabled: boolean, owner?: FeatureReadOwner) {
  return useAccessQuery(
    [...accessKeys.usersBenchmark, window],
    (signal) => apiClient.request(access.users.benchmark, { query: { window, limit: 50 }, signal, routeId }),
    enabled,
    owner,
  );
}

export function useTeamsQuery(enabled = true) {
  return useAccessQuery(
    accessKeys.teams,
    (signal) => apiClient.request(access.teams.list, { signal, routeId }),
    enabled,
  );
}

export function useTeamUsageQuery(owner: FeatureReadOwner) {
  return useAccessQuery(
    [...accessKeys.teams, "usage"],
    (signal) => apiClient.request(access.teams.usage, { query: { view: "usage" }, signal, routeId }),
    true,
    owner,
  );
}

export function useTeamBenchmarkQuery(window: string, enabled: boolean, owner?: FeatureReadOwner) {
  return useAccessQuery(
    [...accessKeys.teamsBenchmark, window],
    (signal) => apiClient.request(access.teams.benchmark, { query: { window }, signal, routeId }),
    enabled,
    owner,
  );
}

export function useTeamScorecardQuery(window: string, enabled: boolean, owner?: FeatureReadOwner) {
  return useAccessQuery(
    [...accessKeys.teamsScorecard, window],
    (signal) => apiClient.request(access.teams.scorecard, { query: { window }, signal, routeId }),
    enabled,
    owner,
  );
}

export function useQuotasQuery(enabled: boolean, owner?: FeatureReadOwner) {
  return useAccessQuery(
    accessKeys.quotas,
    (signal) => apiClient.request(access.quotas.list, { signal, routeId }),
    enabled,
    owner,
  );
}

export function useBudgetsQuery(enabled: boolean, owner?: FeatureReadOwner) {
  return useAccessQuery(
    accessKeys.budgets,
    (signal) => apiClient.request(access.budgets.list, { signal, routeId }),
    enabled,
    owner,
  );
}

export function useBudgetProjectionQuery(enabled: boolean, owner?: FeatureReadOwner) {
  return useAccessQuery(
    accessKeys.budgetProjection,
    (signal) => apiClient.request(access.budgets.projection, { signal, routeId }),
    enabled,
    owner,
  );
}

export function useApiKeysQuery(enabled: boolean, owner?: string, readOwner?: FeatureReadOwner) {
  return useAccessQuery(
    owner ? [...accessKeys.apiKeys, owner] : accessKeys.apiKeys,
    (signal) => apiClient.request(access.apiKeys.list, { signal, routeId }),
    enabled,
    readOwner,
  );
}

export function useRolesQuery(enabled: boolean, owner?: string) {
  return useAccessQuery(
    owner ? [...accessKeys.roles, owner] : accessKeys.roles,
    (signal) => apiClient.request(access.roles.list, { signal, routeId }),
    enabled,
  );
}
