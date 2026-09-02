import { useQuery } from "@tanstack/react-query";

import type { HealthRange } from "@/features/health/health-utils";
import { refreshIntervalMs } from "@/features/health/health-utils";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { usePreferences } from "@/shared/stores/preferences";

const routeId = "gateway.providers";

export function useProviderCatalogQueries(range: HealthRange, canReadRouting: boolean) {
  const refreshInterval = usePreferences((state) => state.refreshInterval);
  const interval = refreshIntervalMs(refreshInterval);
  const providers = useQuery({
    queryKey: ["admin", "providers"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.admin.providers.list, {
        signal,
        routeId,
      }),
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
  const slo = useQuery({
    queryKey: ["admin", "providers", "slo", range],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.admin.providers.slo, {
        query: { window: range },
        signal,
        routeId,
      }),
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
  const routing = useQuery({
    queryKey: ["admin", "routing", "health", range],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.admin.routing.health, {
        query: { window: range, threshold: 70 },
        signal,
        routeId,
      }),
    enabled: canReadRouting,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });

  return { providers, routing, slo } as const;
}
