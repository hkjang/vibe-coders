import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";

const access = endpoints.domains.access;
const routeId = "team.home";

export const teamQueryKeys = {
  all: ["team"] as const,
  dashboard: ["team", "dashboard"] as const,
  reports: ["team", "reports"] as const,
  savings: ["team", "savings-challenge"] as const,
  onboarding: ["team", "onboarding"] as const,
  risk: ["team", "risk"] as const,
  skills: ["team", "skills"] as const,
  candidates: ["team", "template-candidates"] as const,
  portal: ["team", "portal"] as const,
};

function useTeamQuery<Result>(
  queryKey: readonly unknown[],
  run: (signal: AbortSignal) => Promise<Result>,
  enabled: boolean,
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

/** `?team=` is only honoured for callers holding `admin:read`; otherwise omit it. */
function scoped(team: string): { window: string; team?: string } {
  return team ? { window: "30d", team } : { window: "30d" };
}

export function useTeamDashboardQuery(team: string, enabled: boolean) {
  return useTeamQuery(
    [...teamQueryKeys.dashboard, team],
    (signal) => apiClient.request(access.team.dashboard, { query: scoped(team), signal, routeId }),
    enabled,
  );
}

export function useTeamReportsQuery(team: string, enabled: boolean) {
  return useTeamQuery(
    [...teamQueryKeys.reports, team],
    (signal) => apiClient.request(access.team.reports, { query: scoped(team), signal, routeId }),
    enabled,
  );
}

export function useTeamSavingsQuery(team: string, enabled: boolean) {
  return useTeamQuery(
    [...teamQueryKeys.savings, team],
    (signal) => apiClient.request(access.team.savingsChallenge, { query: scoped(team), signal, routeId }),
    enabled,
  );
}

export function useTeamOnboardingQuery(team: string, enabled: boolean) {
  return useTeamQuery(
    [...teamQueryKeys.onboarding, team],
    (signal) =>
      apiClient.request(access.team.onboarding, {
        query: team ? { window: "90d", team } : { window: "90d" },
        signal,
        routeId,
      }),
    enabled,
  );
}

export function useTeamRiskQuery(team: string, enabled: boolean) {
  return useTeamQuery(
    [...teamQueryKeys.risk, team],
    (signal) =>
      apiClient.request(access.team.risk, {
        query: team ? { window: "7d", team } : { window: "7d" },
        signal,
        routeId,
      }),
    enabled,
  );
}

export function useTeamSkillsQuery(team: string, enabled: boolean) {
  return useTeamQuery(
    [...teamQueryKeys.skills, team],
    (signal) => apiClient.request(access.team.popularSkills, { query: scoped(team), signal, routeId }),
    enabled,
  );
}

export function useTeamCandidatesQuery(team: string, enabled: boolean) {
  return useTeamQuery(
    [...teamQueryKeys.candidates, team],
    (signal) =>
      apiClient.request(access.team.templateCandidates, {
        query: team ? { window: "30d", min_count: 3, team } : { window: "30d", min_count: 3 },
        signal,
        routeId,
      }),
    enabled,
  );
}

export function useTeamPortalQuery(team: string, enabled: boolean) {
  return useTeamQuery(
    [...teamQueryKeys.portal, team],
    (signal) => apiClient.request(access.team.portal, { query: scoped(team), signal, routeId }),
    enabled,
  );
}
