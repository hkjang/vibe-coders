import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import type { McpRequestQuery } from "@/shared/api/domains/mcp";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";

function useOwned<T>(
  owner: FeatureReadOwner,
  key: readonly unknown[],
  read: (signal: AbortSignal) => Promise<T>,
  enabled: boolean,
  interval: number | false = false,
) {
  return useQuery({
    queryKey: featureOwnedKey(key, owner),
    enabled,
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

export function useMcpRequestData(
  owner: FeatureReadOwner,
  query: McpRequestQuery,
  requestId: string,
  interval: number | false,
) {
  const routeId = "mcp.overview";
  const requests = useOwned(
    owner,
    ["mcp", "requests", query],
    (signal) => apiClient.request(endpoints.domains.mcp.requests, { query, signal, routeId }),
    true,
    interval,
  );
  const waterfall = useOwned(
    owner,
    ["mcp", "requests", requestId, "waterfall"],
    (signal) =>
      apiClient.request(withPathParams(endpoints.domains.mcp.requestWaterfall, { id: requestId }), {
        signal,
        routeId,
      }),
    requestId !== "",
  );
  const agentic = useOwned(
    owner,
    ["mcp", "agentic-runs", requestId],
    (signal) =>
      apiClient.request(endpoints.domains.mcp.agenticRuns, {
        query: { request_id: requestId },
        signal,
        routeId,
      }),
    requestId !== "",
  );
  return { requests, waterfall, agentic };
}
