import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import type { ModelUsageTagsResponse } from "@/shared/api/schemas";
import type { ModelTagAccess } from "./model-tag-access";
import { tagListReason } from "./model-tag-state";

export function useModelTagData(access: ModelTagAccess) {
  const client = useQueryClient();
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function assertOwned() {
    access.assertOwned();
    if (!mounted.current) throw new AppError("종료된 태그 목록입니다.", { kind: "aborted" });
  }
  function assertRead() {
    assertOwned();
    access.assertRead();
  }
  const key = ["admin", "model-tags", access.epoch, access.owner] as const;
  const query = useQuery({
    queryKey: key,
    enabled: access.readAllowed,
    retry: false,
    queryFn: async ({ signal }) => {
      assertRead();
      const result = await apiClient.request(endpoints.admin.models.tags, {
        signal,
        routeId: "gateway.chat",
      });
      assertRead();
      return result;
    },
  });
  const state = useSyncExternalStore(
    useCallback((notify) => client.getQueryCache().subscribe(notify), [client]),
    () => client.getQueryState<ModelUsageTagsResponse>(key),
  );
  const confirmed = state?.status === "success" && state.fetchStatus === "idle" && !state.isInvalidated;
  function assertConfirmed() {
    assertRead();
    const latest = client.getQueryState<ModelUsageTagsResponse>(key);
    if (
      latest?.status !== "success" ||
      latest.fetchStatus !== "idle" ||
      latest.isInvalidated ||
      !latest.data ||
      new Set(latest.data.tags.map((row) => row.model)).size !== latest.data.tags.length
    )
      throw new AppError(tagListReason, { kind: "contract" });
    return latest.data.tags;
  }
  async function refresh() {
    assertRead();
    await query.refetch();
  }
  // The committed mutation is already successful. A follow-up GET failure must
  // never be reported as a failed save, nor trigger another POST.
  function afterCommit() {
    assertOwned();
    // The model catalog also consumes this resource under the legacy prefix.
    // Invalidate both representations without starting another route's reads.
    void client.invalidateQueries({ queryKey: ["admin", "model-tags"], refetchType: "none" });
    try {
      assertRead();
      void refresh().catch(() => undefined);
    } catch {
      /* no new read after revocation/disposal */
    }
  }
  return { query, confirmed, assertConfirmed, refresh, afterCommit };
}
export type ModelTagData = ReturnType<typeof useModelTagData>;
