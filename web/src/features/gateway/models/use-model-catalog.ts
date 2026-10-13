import { modelOwnedKey, useModelReadOwner } from "./model-read-owner";
import { assertFeatureRead } from "@/shared/hooks/use-feature-read-owner";
import { useQuery } from "@tanstack/react-query";

import type { HealthRange } from "@/features/health/health-utils";
import { refreshIntervalMs } from "@/features/health/health-utils";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { usePreferences } from "@/shared/stores/preferences";

const routeId = "gateway.models";

export function useModelCatalogQueries(range: HealthRange) {
  const owner = useModelReadOwner();
  const read = async <T>(signal: AbortSignal, operation: () => Promise<T>) => {
    assertFeatureRead(owner, signal);
    const result = await operation();
    assertFeatureRead(owner, signal);
    return result;
  };
  const refreshInterval = usePreferences((state) => state.refreshInterval);
  const interval = refreshIntervalMs(refreshInterval);
  const sharedOptions = {
    enabled: owner.readable && !owner.denied,
    gcTime: 0,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  } as const;

  const models = useQuery({
    queryKey: modelOwnedKey(["admin", "models"], owner),
    queryFn: ({ signal }) =>
      read(signal, () => apiClient.request(endpoints.admin.models.list, { signal, routeId })),
    ...sharedOptions,
  });
  const quality = useQuery({
    queryKey: modelOwnedKey(["admin", "models", "quality", range], owner),
    queryFn: ({ signal }) =>
      read(signal, () =>
        apiClient.request(endpoints.admin.models.quality, {
          query: { window: range },
          signal,
          routeId,
        }),
      ),
    ...sharedOptions,
  });
  const pricing = useQuery({
    queryKey: modelOwnedKey(["admin", "pricing"], owner),
    queryFn: ({ signal }) =>
      read(signal, () => apiClient.request(endpoints.admin.models.pricing, { signal, routeId })),
    ...sharedOptions,
  });
  const tags = useQuery({
    queryKey: modelOwnedKey(["admin", "model-tags"], owner),
    queryFn: ({ signal }) =>
      read(signal, () => apiClient.request(endpoints.admin.models.tags, { signal, routeId })),
    ...sharedOptions,
  });

  return { models, pricing, quality, tags } as const;
}
