import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";

export function useMcpOverviewData(owner: FeatureReadOwner) {
  const interval = useRefreshInterval();
  const options = {
    gcTime: 0,
    retry: false as const,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  };
  const overview = useQuery({
    ...options,
    queryKey: featureOwnedKey(["mcp", "overview"], owner),
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await apiClient.request(endpoints.domains.mcp.overview, {
        signal,
        routeId: "mcp.overview",
      });
      assertFeatureRead(owner, signal);
      return data;
    },
  });
  const routes = useQuery({
    ...options,
    queryKey: featureOwnedKey(["mcp", "routes"], owner),
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await apiClient.request(endpoints.domains.mcp.routes, { signal, routeId: "mcp.overview" });
      assertFeatureRead(owner, signal);
      return data;
    },
  });
  const topology = useQuery({
    ...options,
    queryKey: featureOwnedKey(["mcp", "topology"], owner),
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await apiClient.request(endpoints.domains.mcp.topology, {
        signal,
        routeId: "mcp.overview",
      });
      assertFeatureRead(owner, signal);
      return data;
    },
  });
  return { overview, routes, topology };
}
