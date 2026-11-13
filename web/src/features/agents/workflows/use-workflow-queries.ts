import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import type { WorkflowPageQuery } from "@/shared/api/domains/workflow-page.schemas";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { workflowsKey } from "./use-workflow-mutations";

/** Detail reads share the page's account/team lifetime and authorization boundary. */
export function useWorkflowRead<T>(
  owner: FeatureReadOwner,
  key: readonly unknown[],
  enabled: boolean,
  read: (signal: AbortSignal) => Promise<T>,
) {
  return useQuery({
    queryKey: featureOwnedKey([...workflowsKey, ...key], owner),
    enabled: enabled && owner.readable && !owner.denied,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const result = await read(signal);
      assertFeatureRead(owner, signal);
      return result;
    },
  });
}

export function useWorkflowPageQuery(query: WorkflowPageQuery, owner: FeatureReadOwner) {
  const interval = useRefreshInterval();
  return useQuery({
    queryKey: featureOwnedKey([...workflowsKey, "page", query], owner),
    enabled: owner.readable && !owner.denied,
    gcTime: 0,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const result = await apiClient.request(endpoints.domains.agents.workflows.page, {
        query,
        signal,
        routeId: "agents.workflows",
      });
      assertFeatureRead(owner, signal);
      if (
        result.limit !== query.limit ||
        result.offset !== query.offset ||
        result.workflows.length !== Math.min(query.limit, Math.max(0, result.total - query.offset)) ||
        new Set(result.workflows.map((row) => row.id)).size !== result.workflows.length ||
        result.summary.total < result.total ||
        result.summary.enabled > result.summary.total
      )
        throw new AppError("워크플로 목록의 조회 범위를 확인하지 못했습니다. 다시 조회하세요.", {
          kind: "contract",
        });
      return result;
    },
  });
}

export function useWorkflowDetailQuery(id: string | undefined, owner: FeatureReadOwner) {
  return useQuery({
    queryKey: featureOwnedKey([...workflowsKey, "detail", id ?? null], owner),
    enabled: id !== undefined && owner.readable && !owner.denied,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      if (!id) throw new AppError("워크플로 상세 주소를 확인하세요.", { kind: "contract" });
      const result = await apiClient.request(endpoints.domains.agents.workflows.detail, {
        query: { view: "detail", id },
        signal,
        routeId: "agents.workflows",
      });
      assertFeatureRead(owner, signal);
      if (result.workflow && result.workflow.id !== id)
        throw new AppError("선택한 워크플로의 정보를 확인하지 못했습니다.", { kind: "contract" });
      return result;
    },
  });
}
