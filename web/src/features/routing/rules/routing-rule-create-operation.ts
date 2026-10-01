import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { apiClient } from "@/shared/api/client";
import { routingCreateEndpoints, type RoutingCreateInput } from "@/shared/api/domains/routing-create";
import { AppError } from "@/shared/api/error";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { useDraftGuard } from "@/shared/unsaved/use-draft-guard";
import type { RoutingCreateAccess } from "./routing-rule-create-access";
import {
  createAcknowledged,
  createAcknowledgedMessage,
  createFields,
  createReviewChanged,
} from "./routing-rule-create-state";
import { routingRulesQueryKey } from "./routing-shared";

export interface CreateReview {
  body: Readonly<RoutingCreateInput>;
  approval: object;
}
export function useRoutingCreateOperation({
  access,
  dirty,
  onClose,
  isReview,
}: {
  access: RoutingCreateAccess;
  dirty: boolean;
  onClose: () => void;
  isReview: (review: CreateReview) => boolean;
}) {
  const client = useQueryClient();
  const parentKey = [...routingRulesQueryKey, access.epoch, access.owner] as const;
  const active = useRef(true);
  const flight = useRef<AbortController | undefined>(undefined);
  const completed = useRef(false);
  const sentUnconfirmed = useRef(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [error, setError] = useState<unknown>();
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  const [phase, setPhase] = useState<"idle" | "creating" | "refreshing">("idle");
  const assertActive = (signal?: AbortSignal) => {
    access.assertRead();
    if (!active.current || signal?.aborted)
      throw new AppError("종료된 규칙 생성입니다.", { kind: "aborted" });
  };
  const dispose = () => {
    active.current = false;
    flight.current?.abort();
  };
  useLayoutEffect(() => {
    active.current = true;
    return dispose;
  }, []);
  const guard = useDraftGuard({
    dirty: dirty && !acknowledged,
    onDiscard: () => {
      dispose();
      onClose();
    },
  });
  const current = (controller: AbortController) => {
    assertActive(controller.signal);
    if (flight.current !== controller) throw new AppError("이전 생성 요청입니다.", { kind: "aborted" });
  };
  const assertReview = (review: CreateReview) => {
    assertActive();
    access.assertApproval(review.approval);
    if (
      !isReview(review) ||
      createFields.some(([field]) => containsPotentialSecret(String(review.body[field]), access.prefixes))
    )
      throw new AppError(createReviewChanged, { kind: "permission" });
  };
  const reviewCurrent = (review: CreateReview) => {
    try {
      assertReview(review);
      return true;
    } catch {
      return false;
    }
  };
  const refreshList = async (controller: AbortController) => {
    current(controller);
    const data = await apiClient.request(routingCreateEndpoints.list, {
      signal: controller.signal,
      routeId: "routing.rules",
    });
    current(controller);
    // An older ordinary list request must not overwrite the new strict result.
    await client.cancelQueries({ queryKey: parentKey, exact: true });
    current(controller);
    client.setQueryData(parentKey, data);
    setRefreshed(true);
    setRefreshFailed(false);
  };
  const settle = (controller: AbortController) => {
    if (flight.current === controller) {
      flight.current = undefined;
      if (active.current) setPhase("idle");
    }
  };
  const save = (review: CreateReview) => {
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
          current(controller);
          assertReview(review);
          // Fixed payload/current approval and dispatch have no intervening await.
          // This latch remains set after any unconfirmed response in this window.
          sentUnconfirmed.current = true;
          setUnconfirmed(true);
          setPhase("creating");
          const response = await apiClient.request(routingCreateEndpoints.create, {
            body: review.body,
            signal: controller.signal,
            routeId: "routing.rules",
          });
          current(controller);
          if (!createAcknowledged(response.rule, review.body))
            throw new AppError("생성 응답을 확인할 수 없습니다.", { kind: "contract" });
          completed.current = true;
          sentUnconfirmed.current = false;
          setUnconfirmed(false);
          setAcknowledged(true);
          toast.success(createAcknowledgedMessage);
          setPhase("refreshing");
          try {
            await client.invalidateQueries({ queryKey: routingRulesQueryKey, refetchType: "none" });
            current(controller);
            await refreshList(controller);
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
            /* Retired owner. */
          }
        },
        () => {},
      )
      .finally(() => settle(controller));
  };
  const refresh = () => {
    if (!active.current || flight.current) return;
    try {
      assertActive();
    } catch {
      return;
    }
    const controller = new AbortController();
    flight.current = controller;
    setPhase("refreshing");
    setError(undefined);
    setRefreshed(false);
    void guard
      .run(
        async () => {
          await refreshList(controller);
          // A GET is neither an attribution nor a non-commit proof; never unlock POST.
        },
        (cause) => {
          try {
            current(controller);
            setError(cause);
            setRefreshFailed(completed.current);
          } catch {
            /* Old read. */
          }
        },
        () => {},
      )
      .finally(() => settle(controller));
  };
  return {
    acknowledged,
    unconfirmed,
    error,
    refreshFailed,
    refreshed,
    phase,
    pending: guard.pending || phase !== "idle",
    reviewCurrent,
    save,
    refresh,
    close: guard.requestClose,
  };
}
