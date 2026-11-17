import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { useSettingsWorkspace } from "./settings-workspace-context";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";

export const routeId = "system.settings";

export const systemSettingsKeys = {
  effective: ["system", "settings", "effective"] as const,
  history: (key: string) => ["system", "settings", "history", key] as const,
  changeSets: ["system", "change-sets"] as const,
  changeSet: (id: string) => ["system", "change-sets", id] as const,
  errors: ["system", "system-errors"] as const,
  sso: ["system", "sso", "keycloak"] as const,
  tracking: ["system", "tracking"] as const,
  mcpOAuth: ["system", "mcp-oauth"] as const,
  roles: ["system", "roles"] as const,
  auditLogs: ["system", "audit", "logs"] as const,
  authEvents: ["system", "audit", "auth-events"] as const,
  retention: ["system", "retention"] as const,
  fallback: ["system", "fallback"] as const,
  notifications: ["system", "notifications"] as const,
};

const system = endpoints.domains.system;

export function useEffectiveSettings() {
  const { owner, effectiveKey } = useSettingsWorkspace();
  const refetchInterval = useRefreshInterval();
  return useQuery({
    queryKey: effectiveKey,
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await apiClient.request(system.settings.effective, { signal, routeId, cache: "no-store" });
      assertFeatureRead(owner, signal);
      return data;
    },
    refetchInterval,
    refetchIntervalInBackground: false,
  });
}

export function useSettingHistory(key: string, enabled: boolean) {
  const { owner } = useSettingsWorkspace();
  return useQuery({
    queryKey: featureOwnedKey(systemSettingsKeys.history(key), owner),
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await apiClient.request(system.settings.history, {
        query: { key, limit: 20 },
        signal,
        routeId,
        cache: "no-store",
      });
      assertFeatureRead(owner, signal);
      return data;
    },
    enabled: enabled && key !== "",
    refetchOnMount: "always",
  });
}

export function useChangeSets(owner: string) {
  const refetchInterval = useRefreshInterval();
  return useQuery({
    queryKey: [...systemSettingsKeys.changeSets, owner],
    gcTime: 0,
    queryFn: ({ signal }) => apiClient.request(system.changeSets.list, { signal, routeId }),
    refetchInterval,
    refetchIntervalInBackground: false,
  });
}

export function useSystemErrors(owner: FeatureReadOwner) {
  const refetchInterval = useRefreshInterval();
  return useQuery({
    queryKey: featureOwnedKey(systemSettingsKeys.errors, owner),
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await apiClient.request(system.systemErrors.list, {
        query: { limit: 100 },
        signal,
        routeId,
        cache: "no-store",
      });
      assertFeatureRead(owner, signal);
      return data;
    },
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

export function useTrackingStatus(owner: FeatureReadOwner) {
  return useQuery({
    queryKey: featureOwnedKey(systemSettingsKeys.tracking, owner),
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await apiClient.request(system.tracking.status, { signal, routeId, cache: "no-store" });
      assertFeatureRead(owner, signal);
      return data;
    },
  });
}

export function useMcpOAuthStatus() {
  return useQuery({
    queryKey: systemSettingsKeys.mcpOAuth,
    queryFn: ({ signal }) => apiClient.request(system.mcpOAuth.status, { signal, routeId }),
  });
}

export function useRoleCatalog(enabled: boolean) {
  return useQuery({
    queryKey: systemSettingsKeys.roles,
    queryFn: ({ signal }) => apiClient.request(system.roles, { signal, routeId }),
    enabled,
  });
}

export function useAuditLogs(limit: number, owner: FeatureReadOwner) {
  const refetchInterval = useRefreshInterval();
  return useQuery({
    queryKey: featureOwnedKey([...systemSettingsKeys.auditLogs, limit], owner),
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await apiClient.request(system.audit.logs, {
        query: { limit },
        signal,
        routeId,
        cache: "no-store",
      });
      assertFeatureRead(owner, signal);
      return data;
    },
    refetchInterval,
    refetchIntervalInBackground: false,
  });
}

export function useAuthEvents(limit: number, owner: FeatureReadOwner) {
  return useQuery({
    queryKey: featureOwnedKey([...systemSettingsKeys.authEvents, limit], owner),
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await apiClient.request(system.audit.authEvents, {
        query: { limit },
        signal,
        routeId,
        cache: "no-store",
      });
      assertFeatureRead(owner, signal);
      return data;
    },
  });
}

export function useRetentionStatus(owner: string) {
  return useQuery({
    queryKey: [...systemSettingsKeys.retention, owner],
    gcTime: 0,
    queryFn: ({ signal }) => apiClient.request(system.retention.status, { signal, routeId }),
  });
}

export function useFallbackStats(owner: string) {
  return useQuery({
    queryKey: [...systemSettingsKeys.fallback, owner],
    gcTime: 0,
    queryFn: ({ signal }) => apiClient.request(system.fallback.status, { signal, routeId }),
  });
}

export function useNotificationConfig(owner: string) {
  return useQuery({
    queryKey: [...systemSettingsKeys.notifications, owner],
    gcTime: 0,
    queryFn: ({ signal }) => apiClient.request(system.notifications.config, { signal, routeId }),
  });
}

export type EffectiveSettingsQuery = UseQueryResult<
  Awaited<ReturnType<typeof apiClient.request<typeof endpoints.domains.system.settings.effective>>>
>;
