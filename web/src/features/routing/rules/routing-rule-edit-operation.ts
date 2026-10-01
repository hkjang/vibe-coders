import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { apiClient } from "@/shared/api/client";
import type { RoutingRule } from "@/shared/api/domains/routing";
import { routingEditEndpoints, type RoutingEditInput } from "@/shared/api/domains/routing-edit";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { AppError } from "@/shared/api/error";
import { useDraftGuard } from "@/shared/unsaved/use-draft-guard";
import type { RoutingEditAccess } from "./routing-rule-edit-access";
import { assertRuleBaseline, ruleAcknowledged } from "./routing-rule-edit-state";
import { routingRulesQueryKey } from "./routing-shared";
import { sameRoutingRule } from "./routing-toggle-state";

interface Stamp {
  query: object;
  updates: number;
  data: unknown;
}
export interface RuleReview {
  patch: RoutingEditInput;
  approval: object;
  own: Stamp;
  parent: Stamp;
}
type RuleList = { rules: RoutingRule[] };

export function useRoutingEditOperation({
  baseline,
  access,
  dirty,
  onClose,
  isReview,
}: {
  baseline: RoutingRule;
  access: RoutingEditAccess;
  dirty: boolean;
  onClose: () => void;
  isReview: (review: RuleReview) => boolean;
}) {
  const client = useQueryClient();
  const lifetime = useId();
  const key = ["routing", "edit-review", access.key, lifetime, baseline.id] as const;
  const parentKey = [...routingRulesQueryKey, access.epoch, access.owner] as const;
  const active = useRef(true);
  const flight = useRef<AbortController | undefined>(undefined);
  const completed = useRef(false);
  const sentUnconfirmed = useRef(false);
  const [saved, setSaved] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [error, setError] = useState<unknown>();
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [phase, setPhase] = useState<"idle" | "checking" | "saving" | "refreshing">("idle");
  const assertActive = (signal?: AbortSignal) => {
    access.assertRead();
    if (!active.current || signal?.aborted)
      throw new AppError("종료된 규칙 편집입니다.", { kind: "aborted" });
  };
  const get = async (signal: AbortSignal) => {
    assertActive(signal);
    const result = await apiClient.request(routingEditEndpoints.list, { signal, routeId: "routing.rules" });
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
      if (flight.current) throw new AppError("현재 편집 요청을 기다려 주세요.", { kind: "aborted" });
      return get(signal);
    },
  });
  const dispose = () => {
    active.current = false;
    flight.current?.abort();
    void client.cancelQueries({ queryKey: key, exact: true });
    client.removeQueries({ queryKey: key, exact: true });
  };
  useLayoutEffect(() => {
    active.current = true;
    return dispose;
    // The mounted editor is keyed by the selection/security lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const guard = useDraftGuard({
    dirty: dirty && !saved,
    onDiscard: () => {
      dispose();
      onClose();
    },
  });
  const stamp = (queryKey: readonly unknown[]): Stamp => {
    const current = client.getQueryCache().find<RuleList>({ queryKey, exact: true });
    if (
      !current ||
      current.state.status !== "success" ||
      current.state.fetchStatus !== "idle" ||
      current.state.isInvalidated ||
      !current.state.data
    )
      throw new AppError("최신 규칙 목록을 정상 조회한 뒤 다시 검토하세요.", { kind: "contract" });
    assertRuleBaseline(current.state.data.rules, baseline);
    return { query: current, updates: current.state.dataUpdateCount, data: current.state.data };
  };
  const capture = () => {
    assertActive();
    access.assertApproval(access.approval);
    return { own: stamp(key), parent: stamp(parentKey) };
  };
  const sameStamp = (a: Stamp, b: Stamp) =>
    a.query === b.query && a.updates === b.updates && a.data === b.data;
  const reviewCurrent = (review: RuleReview) => {
    try {
      return (
        review.approval === access.approval &&
        sameStamp(stamp(key), review.own) &&
        sameStamp(stamp(parentKey), review.parent)
      );
    } catch {
      return false;
    }
  };
  const assertReview = (review: RuleReview) => {
    assertActive();
    access.assertApproval(review.approval);
    if (
      !isReview(review) ||
      !sameStamp(stamp(key), review.own) ||
      !sameStamp(stamp(parentKey), review.parent)
    )
      throw new AppError("검토한 목록 기준이 바뀌었습니다. 다시 편집으로 돌아가 검토하세요.", {
        kind: "contract",
      });
  };
  const current = (controller: AbortController) => {
    assertActive(controller.signal);
    if (flight.current !== controller) throw new AppError("이전 편집 요청입니다.", { kind: "aborted" });
  };
  const publish = async (data: RuleList, controller: AbortController) => {
    // Cancel older ordinary reads before publishing a newer strict response.
    // Transport cancellation alone need not stop the old server response.
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
  const save = (review: RuleReview) => {
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
          assertReview(review);
          assertRuleBaseline(before.rules, baseline);
          // Current permission/review checks and dispatch have no intervening await.
          sentUnconfirmed.current = true;
          setUnconfirmed(true);
          setPhase("saving");
          const response = await apiClient.request(
            withPathParams(routingEditEndpoints.update, { id: baseline.id }),
            {
              body: review.patch,
              signal: controller.signal,
              routeId: "routing.rules",
            },
          );
          current(controller);
          if (!ruleAcknowledged(response.rule, baseline, review.patch))
            throw new AppError("저장 응답을 확인할 수 없습니다.", { kind: "contract" });
          completed.current = true;
          sentUnconfirmed.current = false;
          setUnconfirmed(false);
          setSaved(true);
          setPhase("refreshing");
          // A valid ACK remains committed even if invalidation/read fails, or write
          // permission alone was withdrawn after dispatch.
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
            /* Security disposal publishes nothing. */
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
          const data = await get(controller.signal);
          await publish(data, controller);
          setRefreshFailed(false);
          // A matching read does not prove an earlier PATCH stopped or failed.
          // sentUnconfirmed intentionally never unlocks within this editor.
        },
        (cause) => {
          try {
            current(controller);
            setError(cause);
            setRefreshFailed(saved);
          } catch {
            /* old read */
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
    /* not current evidence */
  }
  return {
    query,
    sourceMatches,
    ready,
    saved,
    unconfirmed,
    error,
    refreshFailed,
    phase,
    pending: guard.pending || phase !== "idle",
    capture,
    reviewCurrent,
    save,
    refresh,
    close: guard.requestClose,
  };
}
