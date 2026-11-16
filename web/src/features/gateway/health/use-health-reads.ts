import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useLayoutEffect, useRef } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { healthDisplayError } from "./health-display-error";
import {
  assertFeatureRead,
  featureOwnedKey,
  useFeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { healthScoreThreshold } from "./health-constants";

/** Recovery uses these two private snapshots, so denial ends their shared lifetime. */
export function useHealthReads(range: string, interval: number | false) {
  const auth = useAuth();
  const client = useQueryClient();
  const owner = useFeatureReadOwner("gateway.health", "gateway-health-read", [], "routing:read");
  const currentRange = useRef(range);
  useLayoutEffect(() => {
    currentRange.current = range;
  }, [range]);
  const routingKey = featureOwnedKey(["admin", "routing", "health", range], owner);
  const balancerKey = featureOwnedKey(["gateway", "routing", "balancer", range], owner);
  const enabled = owner.readable && !owner.denied;
  const options = {
    enabled,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: enabled ? interval : false,
    refetchIntervalInBackground: false,
  } as const;
  const routing = useQuery({
    ...options,
    queryKey: routingKey,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await apiClient.request(endpoints.admin.routing.health, {
        query: { window: range, threshold: healthScoreThreshold },
        signal,
        routeId: "gateway.health",
      });
      assertFeatureRead(owner, signal);
      return data;
    },
  });
  const balancer = useQuery({
    ...options,
    queryKey: balancerKey,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await apiClient.request(endpoints.domains.gateway.routing.balancer, {
        query: { window: range },
        signal,
        routeId: "gateway.health",
      });
      assertFeatureRead(owner, signal);
      return data;
    },
  });
  function visible<Data>(query: UseQueryResult<Data, Error>) {
    const error = query.error ? healthDisplayError(query.error, auth.credentialPrefixes) : null;
    const current = owner.isCurrent();
    return {
      ...query,
      error,
      data: current ? query.data : undefined,
      dataUpdatedAt: current ? query.dataUpdatedAt : 0,
      isPending: enabled && query.isPending,
      isFetching: enabled && query.isFetching,
      refetch: () => {
        if (owner.denied) owner.restart();
        else if (owner.isCurrent()) void query.refetch();
      },
    };
  }
  const isSnapshotCurrent = (kind: "breaker" | "sessions", snapshot: unknown) => {
    const state = client.getQueryState(kind === "sessions" ? balancerKey : routingKey);
    return (
      owner.isCurrent() &&
      currentRange.current === range &&
      snapshot !== undefined &&
      state?.data === snapshot &&
      state.status === "success" &&
      state.fetchStatus === "idle"
    );
  };
  return { owner, routing: visible(routing), balancer: visible(balancer), isSnapshotCurrent };
}
