import { useQueryClient, type QueryKey, type UseQueryResult } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { AppError } from "@/shared/api/error";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { assertFeatureRead, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import type { ActionSelection } from "@/shared/telemetry/action-channel";

/** One confirmed attempt per successful read; an uncertain response needs a new read and review. */
export function useRecordActionReview<Data, Action>({
  observation,
  owner,
  query,
  queryKey,
  hasAdminWrite,
  execute,
  invalidates,
  successMessage,
}: {
  observation: ActionSelection<Action>;
  owner: FeatureReadOwner;
  query: UseQueryResult<Data>;
  queryKey: QueryKey;
  hasAdminWrite: boolean;
  execute: (action: Action, data: Data) => Promise<unknown>;
  invalidates: readonly QueryKey[];
  successMessage: string;
}) {
  const client = useQueryClient();
  const access = useFeatureMutationAccess(["system.settings"], hasAdminWrite);
  const count = client.getQueryState(queryKey)?.dataUpdateCount ?? 0;
  const [review, setReview] = useState<{ count: number; action: Action; data: Data }>();
  const [attempt, setAttempt] = useState<number>();
  const sent = useRef<number | undefined>(undefined);
  const ready = query.isSuccess && !query.isFetching && owner.isCurrent();
  const latest = useRef({ count, ready, review });
  useLayoutEffect(() => {
    latest.current = { count, ready, review };
  }, [count, ready, review]);
  const mutation = useMutationFeedback({
    observation: (input) => (typeof observation === "function" ? observation(input.action) : observation),
    gcTime: 0,
    ownsResult: owner.isCurrent,
    mutate: async (selected: NonNullable<typeof review>) => {
      assertFeatureRead(owner);
      access.assertCurrent();
      const current = latest.current;
      const live = client.getQueryState(queryKey);
      if (
        live?.status !== "success" ||
        live.fetchStatus !== "idle" ||
        live.dataUpdateCount !== selected.count ||
        !current.ready ||
        current.review !== selected ||
        current.count !== selected.count ||
        sent.current === selected.count
      )
        throw new AppError("최신 기록을 다시 조회하고 변경 내용을 확인하세요.", { kind: "aborted" });
      sent.current = selected.count;
      setAttempt(selected.count);
      return execute(selected.action, selected.data);
    },
    invalidates,
    successMessage,
    errorMessage: "변경 결과를 확인하지 못했습니다. 기록을 다시 조회한 뒤 검토하세요.",
  });
  const available = access.allowed && ready && attempt !== count && !mutation.isPending;
  return {
    review,
    reason: access.reason,
    available,
    current: available && review?.count === count,
    attempted: attempt !== undefined && !mutation.isPending && !mutation.isSuccess,
    pending: mutation.isPending,
    open: (action: Action) => {
      if (available && query.data !== undefined) setReview({ count, action, data: query.data });
    },
    close: () => setReview(undefined),
    confirm: async () => {
      if (review) await mutation.mutateAsync(review);
    },
  };
}
