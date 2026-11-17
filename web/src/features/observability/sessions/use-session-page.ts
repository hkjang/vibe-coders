import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import type { SessionExplorerQuery, SessionExplorerRow } from "@/shared/api/domains/session-page.schema";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";

export function useSessionPage(query: SessionExplorerQuery, owner: FeatureReadOwner, valid: boolean) {
  const client = useQueryClient();
  const interval = useRefreshInterval();
  const key = featureOwnedKey(["admin", "session-page", query], owner);
  const result = useQuery({
    queryKey: key,
    enabled: valid && owner.readable && !owner.denied,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const page = await apiClient.request(endpoints.domains.observability.sessionPage, {
        query,
        signal,
        cache: "no-store",
        routeId: "observability.sessions",
      });
      assertFeatureRead(owner, signal);
      if (page.days !== query.days || page.limit !== query.limit || page.offset !== query.offset)
        throw new AppError("세션 조회 기준이 응답과 다릅니다.", { kind: "contract" });
      return page;
    },
    retry: false,
    gcTime: 0,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
  const readCount = client.getQueryState(key)?.dataUpdateCount;
  const canOpen = (row: SessionExplorerRow) => {
    const state = client.getQueryState(key);
    return (
      owner.isCurrent() &&
      result.isSuccess &&
      !result.isFetching &&
      state?.status === "success" &&
      state.fetchStatus === "idle" &&
      !state.isInvalidated &&
      state.data === result.data &&
      state.dataUpdateCount === readCount &&
      !!row.session_id &&
      result.data.sessions.includes(row)
    );
  };
  return { result, canOpen };
}
