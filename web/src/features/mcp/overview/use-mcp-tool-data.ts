import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import type { McpToolQuery } from "@/shared/api/domains/mcp";
import { endpoints } from "@/shared/api/endpoints";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";

function useOwned<T>(
  owner: FeatureReadOwner,
  key: readonly unknown[],
  read: (signal: AbortSignal) => Promise<T>,
  interval: number | false = false,
) {
  return useQuery({
    queryKey: featureOwnedKey(key, owner),
    gcTime: 0,
    retry: false,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const result = await read(signal);
      assertFeatureRead(owner, signal);
      return result;
    },
  });
}

export function useMcpToolData(owner: FeatureReadOwner, query: McpToolQuery, interval: number | false) {
  const routeId = "mcp.overview";
  const tools = useOwned(
    owner,
    ["mcp", "tools", query],
    (signal) => apiClient.request(endpoints.domains.mcp.tools, { query, signal, routeId }),
    interval,
  );
  const { server, tool, mcp_only } = query;
  const servers = useOwned(owner, ["mcp", "servers", server, tool, mcp_only], (signal) =>
    apiClient.request(endpoints.domains.mcp.servers, {
      query: { server, tool, mcp_only, limit: 200 },
      signal,
      routeId,
    }),
  );
  const catalog = useOwned(owner, ["mcp", "catalog", server], (signal) =>
    apiClient.request(endpoints.domains.mcp.catalog, { query: { server }, signal, routeId }),
  );
  const trust = useOwned(owner, ["mcp", "trust-scores"], (signal) =>
    apiClient.request(endpoints.domains.mcp.trustScores, { query: { days: 30 }, signal, routeId }),
  );
  return { tools, servers, catalog, trust };
}
