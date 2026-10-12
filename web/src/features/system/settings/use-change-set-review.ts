import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChangeSet } from "@/shared/api/domains/system.schemas";
import { AppError } from "@/shared/api/error";
import { lifecycleConfigs, type LifecycleAction } from "./change-set-model";

/** A review belongs to one cache object and one immutable query-state revision. */
export function useChangeSetReview(queryKey: QueryKey) {
  const client = useQueryClient();
  const cache = client.getQueryCache();
  const find = () => cache.find({ queryKey, exact: true });
  const subscribe = useCallback((notify: () => void) => cache.subscribe(notify), [cache]);
  const state = useSyncExternalStore(subscribe, () => find()?.state);
  type Snapshot = Readonly<{
    query: NonNullable<ReturnType<typeof find>>;
    state: NonNullable<typeof state>;
    row: ChangeSet;
    action: LifecycleAction;
  }>;
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const current = useRef<Snapshot | undefined>(undefined);
  const sent = useRef(false);
  const [wasSent, setWasSent] = useState(false);
  useLayoutEffect(
    () => () => {
      current.current = undefined;
    },
    [],
  );
  const fresh = (review: Snapshot | undefined) =>
    review !== undefined &&
    find() === review.query &&
    review.query.state === review.state &&
    review.state.status === "success" &&
    review.state.fetchStatus === "idle" &&
    !review.state.isInvalidated;
  return {
    revision: state,
    canBegin: state?.status === "success" && state.fetchStatus === "idle" && !state.isInvalidated,
    snapshot,
    wasSent,
    matches: state === snapshot?.state && fresh(snapshot),
    begin: (row: ChangeSet, action: LifecycleAction) => {
      const query = find();
      if (
        !query ||
        query.state.status !== "success" ||
        query.state.fetchStatus !== "idle" ||
        query.state.isInvalidated
      )
        return false;
      const rows = client.getQueryData<{ change_sets?: ChangeSet[] | null }>(queryKey)?.change_sets;
      if (!rows?.includes(row) || !lifecycleConfigs[action].enabledFor.includes(row.status ?? ""))
        return false;
      const next = Object.freeze({ query, state: query.state, row, action });
      current.current = next;
      sent.current = false;
      setWasSent(false);
      setSnapshot(next);
      return true;
    },
    clear: () => {
      current.current = undefined;
      setSnapshot(undefined);
    },
    claim: (action: LifecycleAction, id: string, target: string | undefined) => {
      const review = current.current;
      if (!fresh(review) || !review || sent.current || review.action !== action || review.row.id !== id)
        throw new AppError("조회 기준이 바뀌었습니다. 취소 후 최신 목록을 다시 검토하세요.", {
          kind: "aborted",
        });
      if (lifecycleConfigs[action].tone === "danger" && target !== id)
        throw new AppError("변경 세트 ID를 정확히 입력하세요.", { kind: "aborted" });
      sent.current = true;
      setWasSent(true);
    },
  };
}
