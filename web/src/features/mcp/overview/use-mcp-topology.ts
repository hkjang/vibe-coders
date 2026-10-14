import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";

export function useMcpTopology(owner: FeatureReadOwner) {
  const interval = useRefreshInterval();
  return useQuery({
    queryKey: featureOwnedKey(["mcp", "topology"], owner),
    gcTime: 0,
    retry: false,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const result = await apiClient.request(endpoints.domains.mcp.topology, {
        signal,
        routeId: "mcp.overview",
      });
      assertFeatureRead(owner, signal);
      return result;
    },
  });
}
