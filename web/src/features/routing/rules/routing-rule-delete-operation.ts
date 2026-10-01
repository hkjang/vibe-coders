import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { apiClient } from "@/shared/api/client";
import type { RoutingRule } from "@/shared/api/domains/routing";
import { routingDeleteEndpoints } from "@/shared/api/domains/routing-delete";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { AppError } from "@/shared/api/error";
import { useDraftGuard } from "@/shared/unsaved/use-draft-guard";
import type { RoutingDeleteAccess } from "./routing-rule-delete-access";
import { assertDeleteBaseline, deleteReviewChanged } from "./routing-rule-delete-state";
import { routingRulesQueryKey } from "./routing-shared";
import { sameRoutingRule } from "./routing-toggle-state";

interface Stamp {
  query: object;
  updates: number;
  data: unknown;
}
export interface DeleteReview {
  approval: object;
  own: Stamp;
  parent: Stamp;
}
type RuleList = { rules: RoutingRule[] };

export function useRoutingDeleteOperation({
  baseline,
  access,
  onClose,
  isReview,
}: {
  baseline: RoutingRule;
  access: RoutingDeleteAccess;
  onClose: () => void;
  isReview: (review: DeleteReview) => boolean;
}) {
  const client = useQueryClient();
  const lifetime = useId();
  const key = ["routing", "delete-review", access.key, lifetime, baseline.id] as const;
  const parentKey = [...routingRulesQueryKey, access.epoch, access.owner] as const;
  const active = useRef(true);
  const flight = useRef<AbortController | undefined>(undefined);
  const completed = useRef(false);
  const sentUnconfirmed = useRef(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [error, setError] = useState<unknown>();
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [phase, setPhase] = useState<"idle" | "checking" | "deleting" | "refreshing">("idle");
  const assertActive = (signal?: AbortSignal) => {
    access.assertRead();
    if (!active.current || signal?.aborted)
      throw new AppError("종료된 규칙 삭제 검토입니다.", { kind: "aborted" });
  };
  const get = async (signal: AbortSignal) => {
    assertActive(signal);
    const result = await apiClient.request(routingDeleteEndpoints.list, { signal, routeId: "routing.rules" });
    assertActive(signal);
    return result;
  };
  const query = useQuery({
    queryKey: key,
    enabled: access.readable,
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: ({ signal }) => {
      if (flight.current) throw new AppError("현재 삭제 요청을 기다려 주세요.", { kind: "aborted" });
      return get(signal);
    },
  });
  const cache = client.getQueryCache();
  // Invalidation and identical-data successes must also update the visible approval.
  useSyncExternalStore(
    (notify) => cache.subscribe(notify),
    () => client.getQueryState(key),
  );
  useSyncExternalStore(
    (notify) => cache.subscribe(notify),
    () => client.getQueryState(parentKey),
  );
  const dispose = () => {
    active.current = false;
    flight.current?.abort();
    void client.cancelQueries({ queryKey: key, exact: true });
    client.removeQueries({ queryKey: key, exact: true });
  };
  useLayoutEffect(() => {
    active.current = true;
    return dispose;
    // The parent keys this dialog by a security lifetime and a selection serial.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const guard = useDraftGuard({
    dirty: false,
    onDiscard: () => {
      dispose();
      onClose();
    },
  });
  const stamp = (queryKey: readonly unknown[]): Stamp => {
    const current = cache.find<RuleList>({ queryKey, exact: true });
    if (
      !current ||
      current.state.status !== "success" ||
      current.state.fetchStatus !== "idle" ||
      current.state.isInvalidated ||
      !current.state.data
    )
      throw new AppError("최신 규칙 목록을 정상 조회한 뒤 삭제 대상을 확인하세요.", { kind: "contract" });
    assertDeleteBaseline(current.state.data.rules, baseline);
    return { query: current, updates: current.state.dataUpdateCount, data: current.state.data };
  };
  const sameStamp = (a: Stamp, b: Stamp) =>
    a.query === b.query && a.updates === b.updates && a.data === b.data;
  const capture = (): DeleteReview => {
    assertActive();
    access.assertApproval(access.approval);
    return { approval: access.approval, own: stamp(key), parent: stamp(parentKey) };
  };
  const assertReview = (review: DeleteReview) => {
    assertActive();
    access.assertApproval(review.approval);
    if (
      !isReview(review) ||
      !sameStamp(stamp(key), review.own) ||
      !sameStamp(stamp(parentKey), review.parent)
    )
      throw new AppError(deleteReviewChanged, { kind: "contract" });
  };
  const reviewCurrent = (review: DeleteReview) => {
    try {
      assertReview(review);
      return true;
    } catch {
      return false;
    }
  };
  const current = (controller: AbortController) => {
    assertActive(controller.signal);
    if (flight.current !== controller) throw new AppError("이전 삭제 요청입니다.", { kind: "aborted" });
  };
  const publish = async (data: RuleList, controller: AbortController) => {
    await client.cancelQueries({ queryKey: parentKey, exact: true });
    await client.cancelQueries({ queryKey: key, exact: true });
    current(controller);
    client.setQueryData(key, data);
    client.setQueryData(parentKey, data);
  };
  const settle = (controller: AbortController) => {
    if (flight.current === controller) {
      flight.current = undefined;
      if (active.current) setPhase("idle");
    }
  };
  const remove = (review: DeleteReview) => {
    if (!active.current || flight.current || completed.current || sentUnconfirmed.current) return;
    try {
      assertReview(review);
    } catch (cause) {
      setError(cause);
      return;
    }
    const controller = new AbortController();
    flight.current = controller;
    setError(undefined);
    void guard
      .run(
        async () => {
          setPhase("checking");
          const before = await get(controller.signal);
          current(controller);
          assertDeleteBaseline(before.rules, baseline);
          assertReview(review);
          // No await separates final approval checks and dispatch. Mark uncertainty
          // synchronously even if read permission disappears before the response.
          sentUnconfirmed.current = true;
          setUnconfirmed(true);
          setPhase("deleting");
          const result = await apiClient.request(
            withPathParams(routingDeleteEndpoints.remove, { id: baseline.id }),
            { signal: controller.signal, routeId: "routing.rules" },
          );
          current(controller);
          if (result.id !== baseline.id || result.status !== "deleted")
            throw new AppError("삭제 응답을 확인할 수 없습니다.", { kind: "contract" });
          completed.current = true;
          sentUnconfirmed.current = false;
          setUnconfirmed(false);
          setAcknowledged(true);
          toast.success("라우팅 규칙 삭제 요청을 확인했습니다.");
          setPhase("refreshing");
          try {
            await client.invalidateQueries({ queryKey: routingRulesQueryKey, refetchType: "none" });
            current(controller);
            await publish(await get(controller.signal), controller);
            setRefreshFailed(false);
          } catch (cause) {
            current(controller);
            setRefreshFailed(true);
            setError(cause);
          }
        },
        (cause) => {
          try {
            current(controller);
            setError(cause);
          } catch {
            /* retired owner */
          }
        },
        () => {},
      )
      .finally(() => settle(controller));
  };
  const refresh = () => {
    if (!active.current || flight.current || client.getQueryState(key)?.fetchStatus === "fetching") return;
    try {
      assertActive();
    } catch {
      return;
    }
    const controller = new AbortController();
    flight.current = controller;
    setError(undefined);
    setPhase("refreshing");
    void guard
      .run(
        async () => {
          await client.invalidateQueries({ queryKey: key, exact: true, refetchType: "none" });
          current(controller);
          await publish(await get(controller.signal), controller);
          setRefreshFailed(false);
          // A later GET never proves the earlier DELETE did not run. No unlock here.
        },
        (cause) => {
          try {
            current(controller);
            setError(cause);
            setRefreshFailed(completed.current);
          } catch {
            /* retired read */
          }
        },
        () => {},
      )
      .finally(() => settle(controller));
  };
  const selected = query.data?.rules.filter((rule) => rule.id === baseline.id);
  const sourceMatches = selected?.length === 1 && sameRoutingRule(selected[0], baseline);
  let ready = false;
  try {
    stamp(key);
    stamp(parentKey);
    ready = true;
  } catch {
    /* no current source */
  }
  return {
    query,
    sourceMatches,
    ready,
    acknowledged,
    unconfirmed,
    error,
    refreshFailed,
    phase,
    pending: guard.pending || phase !== "idle",
    capture,
    reviewCurrent,
    remove,
    refresh,
    close: guard.requestClose,
  };
}
