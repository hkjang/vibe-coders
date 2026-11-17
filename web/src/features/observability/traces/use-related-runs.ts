import { useQuery } from "@tanstack/react-query";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import type { TraceRelatedRunsQuery } from "@/shared/api/domains/trace-related-runs.schema";
import { AppError } from "@/shared/api/error";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";

export function useRelatedRuns(traceId: string, query: TraceRelatedRunsQuery, owner: FeatureReadOwner) {
  return useQuery({
    queryKey: featureOwnedKey(["admin", "trace-related-runs", traceId, query], owner),
    enabled: owner.readable && !owner.denied,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const page = await apiClient.request(
        withPathParams(endpoints.domains.observability.relatedRuns, { trace_id: traceId }),
        {
          query,
          signal,
          cache: "no-store",
          routeId: "observability.traces",
        },
      );
      assertFeatureRead(owner, signal);
      if (page.kind !== query.kind || page.limit !== query.limit || page.offset !== query.offset)
        throw new AppError("연관 실행 조회 기준이 응답과 다릅니다.", { kind: "contract" });
      return page;
    },
    retry: false,
    gcTime: 0,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
}
