import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";

export function useMcpPolicyQuery<T>(
  owner: FeatureReadOwner,
  key: readonly unknown[],
  read: (signal: AbortSignal) => Promise<T>,
  enabled = true,
) {
  return useQuery({
    queryKey: featureOwnedKey(key, owner),
    enabled,
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await read(signal);
      assertFeatureRead(owner, signal);
      return data;
    },
  });
}
export function useMcpPolicyData(owner: FeatureReadOwner, lookup?: { server: string; tool: string }) {
  const routeId = "mcp.overview";
  const policies = useMcpPolicyQuery(owner, ["mcp", "policies"], (signal) =>
    apiClient.request(endpoints.domains.mcp.policies, { signal, routeId }),
  );
  const loops = useMcpPolicyQuery(owner, ["mcp", "loops"], (signal) =>
    apiClient.request(endpoints.domains.mcp.loops, {
      query: { window: "24h", threshold: 10, limit: 50 },
      signal,
      routeId,
    }),
  );
  const effective = useMcpPolicyQuery(
    owner,
    ["mcp", "effective-policy", lookup],
    (signal) =>
      apiClient.request(endpoints.domains.mcp.effectivePolicy, {
        query: { server: lookup?.server ?? "", ...(lookup?.tool ? { tool: lookup.tool } : {}) },
        signal,
        routeId,
      }),
    Boolean(lookup?.server),
  );
  return { policies, loops, effective };
}
