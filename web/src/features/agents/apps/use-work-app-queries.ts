import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import type { WorkAppPageQuery } from "@/shared/api/domains/work-app-page.schemas";
import { assertFeatureRead, featureOwnedKey } from "@/shared/hooks/use-feature-read-owner";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { appsKey, useAppScope } from "./app-scope";

export function useWorkAppPageQuery(query: WorkAppPageQuery) {
  const owner = useAppScope();
  const interval = useRefreshInterval();
  return useQuery({
    // Ownership markers stay last so denial and unmount purge these reads.
    queryKey: featureOwnedKey([...appsKey, "catalog", "page", query], owner),
    enabled: owner.readable && !owner.denied,
    gcTime: 0,
    retry: false,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const result = await apiClient.request(endpoints.domains.agents.apps.page, {
        query,
        signal,
        routeId: "agents.apps",
      });
      assertFeatureRead(owner, signal);
      if (
        result.limit !== query.limit ||
        result.offset !== query.offset ||
        result.apps.length !== Math.min(query.limit, Math.max(0, result.total - query.offset)) ||
        new Set(result.apps.map((row) => row.id)).size !== result.apps.length ||
        result.summary.total < result.total ||
        result.summary.active + result.summary.archived > result.summary.total ||
        result.summary.unscoped > result.summary.total
      )
        throw new AppError("업무 앱 목록의 조회 범위를 확인하지 못했습니다. 다시 조회하세요.", {
          kind: "contract",
        });
      return result;
    },
  });
}

export function useWorkAppDetailQuery(id: string | undefined) {
  const owner = useAppScope();
  return useQuery({
    queryKey: featureOwnedKey([...appsKey, "catalog", "detail", id ?? null], owner),
    enabled: id !== undefined && owner.readable && !owner.denied,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      if (!id) throw new AppError("업무 앱 상세 주소를 확인하세요.", { kind: "contract" });
      const result = await apiClient.request(endpoints.domains.agents.apps.detail, {
        query: { view: "detail", id },
        signal,
        routeId: "agents.apps",
      });
      assertFeatureRead(owner, signal);
      if (result.app && result.app.id !== id)
        throw new AppError("선택한 업무 앱의 정보를 확인하지 못했습니다.", { kind: "contract" });
      return result;
    },
  });
}
