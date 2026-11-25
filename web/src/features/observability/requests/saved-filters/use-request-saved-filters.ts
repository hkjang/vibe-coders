import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";

type FilterChange =
  | { kind: "create"; name: string; params: string }
  | { kind: "rename"; id: string; name: string }
  | { kind: "delete"; id: string };
const endpoint = endpoints.domains.observability.savedFilters;

export function useRequestSavedFilters(owner: FeatureReadOwner, expanded: boolean, assertWrite: () => void) {
  const key = featureOwnedKey(["observability", "requests", "saved-filters"], owner);
  const filters = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const response = await apiClient.request(endpoint.list, {
        query: { view: "requests" },
        signal,
        routeId: "observability.requests",
      });
      assertFeatureRead(owner, signal);
      return response;
    },
    enabled: expanded && owner.readable && !owner.denied,
    staleTime: 30_000,
    retry: false,
  });
  const change = useMutationFeedback<FilterChange, unknown>({
    observation: (value) => (value.kind === "create" || value.kind === "rename" ? "save" : "delete"),
    gcTime: 0,
    ownsResult: () => owner.isCurrent(),
    mutate: (value) => {
      assertFeatureRead(owner);
      assertWrite();
      if (value.kind === "create")
        return apiClient.request(endpoint.create, {
          body: { name: value.name, params: value.params, view: "requests" },
          routeId: "observability.requests",
        });
      if (value.kind === "rename")
        return apiClient.request(withPathParams(endpoint.update, { id: value.id }), {
          body: { name: value.name },
          routeId: "observability.requests",
        });
      return apiClient.request(withPathParams(endpoint.remove, { id: value.id }), {
        routeId: "observability.requests",
      });
    },
    invalidates: [key],
    successMessage: (_, value) =>
      value.kind === "create"
        ? "공유 필터를 저장했습니다."
        : value.kind === "rename"
          ? "공유 필터 이름을 변경했습니다."
          : "공유 필터를 삭제했습니다.",
    errorMessage: "공유 필터를 변경하지 못했습니다.",
  });
  return { filters, change };
}
