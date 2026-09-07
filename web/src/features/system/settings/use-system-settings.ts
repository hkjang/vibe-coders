import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";

export const routeId = "system.settings";

export const systemSettingsKeys = {
  effective: ["system", "settings", "effective"] as const,
  history: (key: string) => ["system", "settings", "history", key] as const,
  changeSets: ["system", "change-sets"] as const,
  changeSet: (id: string) => ["system", "change-sets", id] as const,
  errors: ["system", "system-errors"] as const,
  sso: ["system", "sso", "keycloak"] as const,
  roles: ["system", "roles"] as const,
  auditLogs: ["system", "audit", "logs"] as const,
  authEvents: ["system", "audit", "auth-events"] as const,
  retention: ["system", "retention"] as const,
  fallback: ["system", "fallback"] as const,
  notifications: ["system", "notifications"] as const,
};

const system = endpoints.domains.system;

export function useEffectiveSettings() {
  const refetchInterval = useRefreshInterval();
  return useQuery({
    queryKey: systemSettingsKeys.effective,
    queryFn: ({ signal }) => apiClient.request(system.settings.effective, { signal, routeId }),
    refetchInterval,
    refetchIntervalInBackground: false,
  });
}

export function useSettingHistory(key: string, enabled: boolean) {
  return useQuery({
    queryKey: systemSettingsKeys.history(key),
    queryFn: ({ signal }) =>
      apiClient.request(system.settings.history, { query: { key, limit: 20 }, signal, routeId }),
    enabled: enabled && key !== "",
  });
}

export function useChangeSets() {
  const refetchInterval = useRefreshInterval();
  return useQuery({
    queryKey: systemSettingsKeys.changeSets,
    queryFn: ({ signal }) => apiClient.request(system.changeSets.list, { signal, routeId }),
    refetchInterval,
    refetchIntervalInBackground: false,
  });
}

export function useSystemErrors() {
  const refetchInterval = useRefreshInterval();
  return useQuery({
    queryKey: systemSettingsKeys.errors,
    queryFn: ({ signal }) =>
      apiClient.request(system.systemErrors.list, { query: { limit: 100 }, signal, routeId }),
    refetchInterval,
    refetchIntervalInBackground: false,
  });
}

export function useKeycloakConfig() {
  return useQuery({
    queryKey: systemSettingsKeys.sso,
    queryFn: ({ signal }) => apiClient.request(system.sso.config, { signal, routeId }),
  });
}

export function useRoleCatalog(enabled: boolean) {
  return useQuery({
    queryKey: systemSettingsKeys.roles,
    queryFn: ({ signal }) => apiClient.request(system.roles, { signal, routeId }),
    enabled,
  });
}

export function useAuditLogs(limit: number) {
  const refetchInterval = useRefreshInterval();
  return useQuery({
    queryKey: [...systemSettingsKeys.auditLogs, limit],
    queryFn: ({ signal }) => apiClient.request(system.audit.logs, { query: { limit }, signal, routeId }),
    refetchInterval,
    refetchIntervalInBackground: false,
  });
}

export function useAuthEvents(limit: number) {
  return useQuery({
    queryKey: [...systemSettingsKeys.authEvents, limit],
    queryFn: ({ signal }) =>
      apiClient.request(system.audit.authEvents, { query: { limit }, signal, routeId }),
  });
}

export function useRetentionStatus() {
  return useQuery({
    queryKey: systemSettingsKeys.retention,
    queryFn: ({ signal }) => apiClient.request(system.retention.status, { signal, routeId }),
  });
}

export function useFallbackStats() {
  return useQuery({
    queryKey: systemSettingsKeys.fallback,
    queryFn: ({ signal }) => apiClient.request(system.fallback.status, { signal, routeId }),
  });
}

export function useNotificationConfig() {
  return useQuery({
    queryKey: systemSettingsKeys.notifications,
    queryFn: ({ signal }) => apiClient.request(system.notifications.config, { signal, routeId }),
  });
}

export type EffectiveSettingsQuery = UseQueryResult<
  Awaited<ReturnType<typeof apiClient.request<typeof endpoints.domains.system.settings.effective>>>
>;
