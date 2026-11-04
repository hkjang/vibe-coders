import { useQuery } from "@tanstack/react-query";

import type { HealthRange } from "@/features/health/health-utils";
import { refreshIntervalMs } from "@/features/health/health-utils";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { usePreferences } from "@/shared/stores/preferences";
import { assertProviderRead, providerOwnedKey, useProviderReadScope } from "./provider-read-owner";

const routeId = "gateway.providers";

export function useProviderCatalogQueries(range: HealthRange, canReadRouting: boolean) {
  const owner = useProviderReadScope();
  const refreshInterval = usePreferences((state) => state.refreshInterval);
  const interval = refreshIntervalMs(refreshInterval);
  const providers = useQuery({
    queryKey: providerOwnedKey(["admin", "providers"], owner),
    queryFn: async ({ signal }) => {
      assertProviderRead(owner, signal);
      const result = await apiClient.request(endpoints.admin.providers.list, {
        signal,
        routeId,
      });
      assertProviderRead(owner, signal);
      return result;
    },
    enabled: owner.readable && !owner.denied,
    gcTime: 0,
    retry: false,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
  const slo = useQuery({
    queryKey: providerOwnedKey(["admin", "providers", "slo", range], owner),
    queryFn: async ({ signal }) => {
      assertProviderRead(owner, signal);
      const result = await apiClient.request(endpoints.admin.providers.slo, {
        query: { window: range },
        signal,
        routeId,
      });
      assertProviderRead(owner, signal);
      return result;
    },
    enabled: owner.readable && !owner.denied,
    gcTime: 0,
    retry: false,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
  const routing = useQuery({
    queryKey: providerOwnedKey(["admin", "routing", "health", range], owner),
    queryFn: async ({ signal }) => {
      assertProviderRead(owner, signal);
      const result = await apiClient.request(endpoints.admin.routing.health, {
        query: { window: range, threshold: 70 },
        signal,
        routeId,
      });
      assertProviderRead(owner, signal);
      return result;
    },
    enabled: canReadRouting && owner.readable && !owner.denied,
    gcTime: 0,
    retry: false,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });

  return { providers, routing, slo } as const;
}
