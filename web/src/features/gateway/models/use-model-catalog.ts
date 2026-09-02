import { useQuery } from "@tanstack/react-query";

import type { HealthRange } from "@/features/health/health-utils";
import { refreshIntervalMs } from "@/features/health/health-utils";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { usePreferences } from "@/shared/stores/preferences";

const routeId = "gateway.models";

export function useModelCatalogQueries(range: HealthRange) {
  const refreshInterval = usePreferences((state) => state.refreshInterval);
  const interval = refreshIntervalMs(refreshInterval);
  const sharedOptions = {
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  } as const;

  const models = useQuery({
    queryKey: ["admin", "models"],
    queryFn: ({ signal }) => apiClient.request(endpoints.admin.models.list, { signal, routeId }),
    ...sharedOptions,
  });
  const quality = useQuery({
    queryKey: ["admin", "models", "quality", range],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.admin.models.quality, {
        query: { window: range },
        signal,
        routeId,
      }),
    ...sharedOptions,
  });
  const pricing = useQuery({
    queryKey: ["admin", "pricing"],
    queryFn: ({ signal }) => apiClient.request(endpoints.admin.models.pricing, { signal, routeId }),
    ...sharedOptions,
  });
  const tags = useQuery({
    queryKey: ["admin", "model-tags"],
    queryFn: ({ signal }) => apiClient.request(endpoints.admin.models.tags, { signal, routeId }),
    ...sharedOptions,
  });

  return { models, pricing, quality, tags } as const;
}
