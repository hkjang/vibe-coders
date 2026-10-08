import { useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { apiClient } from "@/shared/api/client";
import {
  domainReviewAckMatches,
  domainReviewDecisionEndpoint,
} from "@/shared/api/domains/routing-domain-review";
import { AppError } from "@/shared/api/error";
import { useDraftGuard } from "@/shared/unsaved/use-draft-guard";
import type { DomainReviewAccess } from "./domain-review-access";
import type { DomainReviewQuery, DomainReviewSnapshot } from "./domain-review-query";
import {
  currentDomainReview,
  domainReviewAcknowledged,
  domainReviewChanged,
  domainReviewProblem,
  domainReviewSafeError,
  type DomainReviewSource,
} from "./domain-review-state";

export interface DomainReviewReview {
  readonly source: DomainReviewSource;
  readonly snapshot: DomainReviewSnapshot;
  readonly approval: object;
}
export function useDomainReviewOperation({
  access,
  query,
  assertSelected,
  isApproved,
  dirty,
  onClose,
}: {
  access: DomainReviewAccess;
  query: DomainReviewQuery;
  assertSelected: () => void;
  isApproved: (candidate: DomainReviewReview) => boolean;
  dirty: boolean;
  onClose: () => void;
}) {
  const active = useRef(false);
  const flight = useRef<AbortController | undefined>(undefined);
  const sent = useRef(false);
  const completed = useRef(false);
  const [phase, setPhase] = useState<"idle" | "recording" | "refreshing">("idle");
  const [acknowledged, setAcknowledged] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  const [error, setError] = useState<AppError>();
  const assertActive = (signal?: AbortSignal) => {
    access.assertRead();
    query.assertRead();
    assertSelected();
    if (!active.current || signal?.aborted)
      throw new AppError("종료된 검토 상태 기록입니다.", { kind: "aborted" });
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
    if (flight.current !== controller) throw new AppError("이전 검토 상태 요청입니다.", { kind: "aborted" });
  };
  const assertReview = (review: DomainReviewReview) => {
    assertActive();
    access.assertApproval(review.approval);
    if (
      !isApproved(review) ||
      !query.isCurrent(review.snapshot) ||
      !currentDomainReview(review.source, review.snapshot.data) ||
      domainReviewProblem(review.source.item, access.prefixes)
    )
      throw new AppError(domainReviewChanged, { kind: "permission" });
  };
  const reviewCurrent = (review: DomainReviewReview) => {
    try {
      assertReview(review);
      return true;
    } catch {
      return false;
    }
  };
  const refreshList = async (controller: AbortController) => {
    current(controller);
    await query.refresh();
    current(controller);
    setRefreshFailed(false);
    setRefreshed(true);
  };
  const settle = (controller: AbortController) => {
    if (flight.current === controller) {
      flight.current = undefined;
      if (active.current) setPhase("idle");
    }
  };
  const save = (review: DomainReviewReview) => {
    if (!active.current || flight.current || sent.current || completed.current) return;
    try {
      assertReview(review);
    } catch (cause) {
      setError(domainReviewSafeError(cause, access.prefixes));
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
          // Exact source/action, consent and query lease are checked immediately
          // before dispatch. This UI latch does not promise HTTP exactly-once.
          const endpoint = domainReviewDecisionEndpoint(review.source.item.id, review.source.action);
          sent.current = true;
          setUnconfirmed(true);
          setPhase("recording");
          const ack = await apiClient.request(endpoint, {
            signal: controller.signal,
            routeId: "routing.rules",
            retryUnauthorized: false,
          });
          current(controller);
          if (!domainReviewAckMatches(ack, review.source.item.id, review.source.action))
            throw new AppError("기록 응답의 검토 ID와 상태를 확인할 수 없습니다.", { kind: "contract" });
          completed.current = true;
          setUnconfirmed(false);
          setAcknowledged(true);
          toast.success(domainReviewAcknowledged);
          setPhase("refreshing");
          try {
            await refreshList(controller);
          } catch (cause) {
            current(controller);
            setRefreshFailed(true);
            setError(domainReviewSafeError(cause, access.prefixes));
          }
        },
        (cause) => {
          try {
            current(controller);
            setError(domainReviewSafeError(cause, access.prefixes));
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
          // A GET never proves whether the prior uncertain POST committed.
          // The sent latch intentionally remains set for this dialog lifetime.
        },
        (cause) => {
          try {
            current(controller);
            setError(domainReviewSafeError(cause, access.prefixes));
            setRefreshFailed(completed.current);
          } catch {
            /* Retired read. */
          }
        },
        () => {},
      )
      .finally(() => settle(controller));
  };
  return {
    phase,
    acknowledged,
    unconfirmed,
    refreshFailed,
    refreshed,
    error,
    pending: guard.pending || phase !== "idle",
    reviewCurrent,
    save,
    refresh,
    close: guard.requestClose,
  };
}
