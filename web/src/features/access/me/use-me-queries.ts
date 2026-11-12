import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useAuth } from "@/app/auth/AuthProvider";
import { assertFeatureRead, featureOwnedKey } from "@/shared/hooks/use-feature-read-owner";
import { useMeOwner } from "./me-console-context";
import { safeMeError } from "./me-console-model";
import { readMeSessions, readMeOnboarding, inspectMeConnection } from "./me-access-api";
import type { ConnectionClient } from "./me-access-model";
import {
  readMeDashboard,
  readMeActions,
  readMeReport,
  readMeNotifications,
  readMeModels,
  readMeRequests,
  readMeReceipt,
  readMeSkills,
  readMeRecommendations,
  type MeRead,
} from "./me-console-api";

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
  doctor: ["me", "connection-doctor"] as const,
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

function usePersonalQuery<Result>(
  key: readonly unknown[],
  read: (scope: MeRead) => Promise<Result>,
  enabled = true,
) {
  const owner = useMeOwner();
  const auth = useAuth();
  const interval = useRefreshInterval();
  return useQuery({
    queryKey: featureOwnedKey(key, owner),
    enabled,
    retry: false,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      try {
        assertFeatureRead(owner, signal);
        const result = await read({
          user: auth.user?.id ?? "",
          team: auth.user?.team_id ?? "",
          prefixes: auth.credentialPrefixes,
          signal,
        });
        assertFeatureRead(owner, signal);
        return result;
      } catch (error) {
        throw safeMeError(error, auth.credentialPrefixes);
      }
    },
  });
}
export const useMeDashboardQuery = () => usePersonalQuery(meKeys.dashboard, readMeDashboard);
export const useMeActionsQuery = () => usePersonalQuery(meKeys.actions, readMeActions);
export const useMeReportQuery = (window: "weekly" | "monthly") =>
  usePersonalQuery([...meKeys.report, window], (scope) => readMeReport(scope, window));
export const useMeNotificationsQuery = () => usePersonalQuery(meKeys.notifications, readMeNotifications);
export const useMeRecommendedModelsQuery = (enabled: boolean) =>
  usePersonalQuery(meKeys.recommendedModels, readMeModels, enabled);
export const useMeRequestsQuery = (limit: number, enabled: boolean) =>
  usePersonalQuery([...meKeys.requests, limit], (scope) => readMeRequests(scope, limit), enabled);
export const useMeReceiptQuery = (id: string, enabled: boolean) =>
  usePersonalQuery(["me", "receipt", id], (scope) => readMeReceipt(scope, id), enabled);
export const useMeSkillsQuery = (enabled: boolean) => usePersonalQuery(meKeys.skills, readMeSkills, enabled);
export const useMeRecommendationsQuery = () =>
  usePersonalQuery(meKeys.recommendations, (scope) => readMeRecommendations(scope));

export function useMeSessionsQuery(enabled: boolean) {
  return usePersonalQuery(meKeys.sessions, readMeSessions, enabled);
}

export function useMeKeysQuery(enabled: boolean, owner?: string) {
  return useMeQuery(
    owner === undefined ? meKeys.keys : [...meKeys.keys, owner],
    (signal) => apiClient.request(access.me.keys, { signal, routeId }),
    enabled,
  );
}

export function useMeOnboardingPackQuery(client: ConnectionClient, enabled: boolean) {
  return usePersonalQuery(
    [...meKeys.onboarding, client],
    (scope) => readMeOnboarding(scope, client),
    enabled,
  );
}
export function useMeDoctorQuery(client: ConnectionClient) {
  // Disabled queries do not poll or refetch on focus/invalidation. This POST
  // runs only when the guarded inspection button calls refetch().
  return usePersonalQuery([...meKeys.doctor, client], (scope) => inspectMeConnection(scope, client), false);
}
