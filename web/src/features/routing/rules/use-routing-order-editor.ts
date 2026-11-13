import { useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/shared/api/client";
import {
  routingOrderEndpoints,
  type OrderSnapshot,
  type OrderPreview,
} from "@/shared/api/domains/routing-order";
import { AppError } from "@/shared/api/error";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { useDraftGuard } from "@/shared/unsaved/use-draft-guard";
import type { RoutingOrderAccess } from "./routing-order-access";
import { moveOrder, orderAcknowledged, orderText, orderUsable } from "./routing-order-state";
import { routingRulesQueryKey } from "./routing-shared";

interface Draft {
  ids: string[];
  model: string;
  complexity: string;
  reason: string;
}
interface Comparison {
  key: string;
  approval: object;
  result: OrderPreview;
}

export function useRoutingOrderEditor(
  snapshot: OrderSnapshot,
  access: RoutingOrderAccess,
  onClose: () => void,
) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<Draft>({
    ids: snapshot.rules.map((rule) => rule.id),
    model: "",
    complexity: "50",
    reason: "",
  });
  const [comparison, setComparison] = useState<Comparison>();
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<unknown>();
  const [problem, setProblem] = useState<{ field: "model" | "complexity" | "reason"; message: string }>();
  const [phase, setPhase] = useState<"idle" | "preview" | "save">("idle");
  const [sent, setSent] = useState(false);
  const [saved, setSaved] = useState(false);
  const [announcement, announce] = useState("");
  const sentRef = useRef(false);
  const flight = useRef<AbortController | undefined>(undefined);
  const active = useRef(false);
  const key = JSON.stringify(draft);
  const latest = useRef({ draft, key, comparison, confirmed, access });
  useLayoutEffect(() => {
    latest.current = { draft, key, comparison, confirmed, access };
  });
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      flight.current?.abort();
    };
  }, []);
  const changed = draft.ids.some(
    (id, index) => id !== snapshot.rules[index]?.id || snapshot.rules[index]?.priority !== index + 1,
  );
  const dirty =
    draft.ids.some((id, index) => id !== snapshot.rules[index]?.id) ||
    draft.model !== "" ||
    draft.reason !== "" ||
    draft.complexity !== "50";
  const guard = useDraftGuard({
    dirty: dirty && !saved,
    externalPending: phase !== "idle",
    onDiscard: () => {
      active.current = false;
      flight.current?.abort();
      onClose();
    },
  });
  const assertCurrent = (controller?: AbortController) => {
    access.assertRead();
    if (!active.current || (controller && (flight.current !== controller || controller.signal.aborted)))
      throw new AppError(orderText.stale, { kind: "aborted" });
  };
  const assertApproval = (approval: object) => {
    assertCurrent();
    latest.current.access.assertApproval(approval);
    if (!orderUsable(snapshot, latest.current.access.prefixes))
      throw new AppError(orderText.stale, { kind: "contract" });
  };
  const update = (next: Draft) => {
    try {
      assertApproval(access.approval);
    } catch {
      return;
    }
    if (flight.current || sentRef.current) return;
    latest.current.draft = next;
    latest.current.key = JSON.stringify(next);
    latest.current.comparison = undefined;
    latest.current.confirmed = false;
    setDraft(next);
    setComparison(undefined);
    setConfirmed(false);
    setError(undefined);
    setProblem(undefined);
  };
  const move = (from: number, to: number) => {
    if (flight.current || sentRef.current || from === to || to < 0 || to >= latest.current.draft.ids.length)
      return;
    const next = moveOrder(latest.current.draft.ids, from, to);
    update({ ...latest.current.draft, ids: next });
    announce(`${from + 1}번째 규칙을 ${to + 1}번째로 이동했습니다.`);
  };
  const settle = (controller: AbortController) => {
    if (flight.current === controller) {
      flight.current = undefined;
      if (active.current) setPhase("idle");
    }
  };
  const preview = () => {
    if (flight.current || sentRef.current) return;
    const captured = latest.current;
    const approval = access.approval;
    let model: string;
    let complexity: number;
    try {
      assertApproval(approval);
      if (captured.key !== key) throw new AppError(orderText.stale, { kind: "contract" });
      model = captured.draft.model.trim();
      complexity = Number(captured.draft.complexity);
      if (!model || [...model].length > 256 || containsPotentialSecret(model, access.prefixes)) {
        setProblem({ field: "model", message: "민감정보를 제외한 모델명을 1~256자로 입력하세요." });
        return;
      }
      if (!/^\d{1,3}$/u.test(captured.draft.complexity) || complexity > 100) {
        setProblem({ field: "complexity", message: "복잡도는 0~100의 정수로 입력하세요." });
        return;
      }
    } catch (cause) {
      setError(cause);
      return;
    }
    const controller = new AbortController();
    flight.current = controller;
    setPhase("preview");
    setError(undefined);
    setComparison(undefined);
    setConfirmed(false);
    void apiClient
      .request(routingOrderEndpoints.preview, {
        body: { model, complexity, rule_order: [...captured.draft.ids], rule_revision: snapshot.revision },
        signal: controller.signal,
        routeId: "routing.rules",
      })
      .then((result) => {
        assertCurrent(controller);
        assertApproval(approval);
        if (latest.current.key !== captured.key || result.revision !== snapshot.revision)
          throw new AppError(orderText.stale, { kind: "contract" });
        const review = { key: captured.key, approval, result };
        latest.current.comparison = review;
        setComparison(review);
      })
      .catch((cause) => {
        try {
          assertCurrent(controller);
          setError(cause);
        } catch {
          /* Retired owner. */
        }
      })
      .finally(() => settle(controller));
  };
  const setConfirmation = (value: boolean) => {
    try {
      assertApproval(access.approval);
    } catch {
      return;
    }
    if (
      flight.current ||
      sentRef.current ||
      !latest.current.comparison ||
      latest.current.comparison.approval !== access.approval ||
      latest.current.comparison.key !== latest.current.key
    )
      return;
    latest.current.confirmed = value;
    setConfirmed(value);
  };
  const save = () => {
    if (flight.current || sentRef.current) return;
    const review = comparison;
    const captured = draft;
    const reason = captured.reason.trim();
    try {
      assertApproval(access.approval);
      if (
        !review ||
        review !== latest.current.comparison ||
        key !== latest.current.key ||
        !latest.current.confirmed ||
        review.key !== latest.current.key ||
        review.approval !== access.approval ||
        !changed
      )
        throw new AppError(orderText.stale, { kind: "contract" });
      if (!reason || [...reason].length > 500 || containsPotentialSecret(reason, access.prefixes)) {
        setProblem({ field: "reason", message: "민감정보를 제외한 변경 사유를 1~500자로 입력하세요." });
        return;
      }
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
          assertCurrent(controller);
          assertApproval(review.approval);
          if (
            latest.current.comparison !== review ||
            latest.current.key !== review.key ||
            !latest.current.confirmed
          )
            throw new AppError(orderText.stale, { kind: "contract" });
          sentRef.current = true;
          setSent(true);
          setPhase("save");
          const after = await apiClient.request(routingOrderEndpoints.save, {
            body: { order: [...captured.ids], expected_revision: snapshot.revision, reason },
            signal: controller.signal,
            routeId: "routing.rules",
          });
          assertCurrent(controller);
          if (!orderAcknowledged(snapshot, captured.ids, after) || after.revision === snapshot.revision)
            throw new AppError(orderText.unknown, { kind: "contract" });
          setSaved(true);
          toast.success(orderText.saved);
          await client.cancelQueries({ queryKey: routingRulesQueryKey });
          assertCurrent(controller);
          client.setQueryData([...routingRulesQueryKey, access.epoch, access.owner], { rules: after.rules });
          await client.invalidateQueries({ queryKey: routingRulesQueryKey, refetchType: "none" });
        },
        (cause) => {
          try {
            assertCurrent(controller);
            setError(cause);
          } catch {
            /* Retired owner. */
          }
        },
        () => {},
      )
      .finally(() => settle(controller));
  };
  const currentComparison =
    comparison?.key === key && comparison.approval === access.approval ? comparison : undefined;
  return {
    draft,
    changed,
    comparison: currentComparison?.result,
    confirmed: confirmed && !!currentComparison,
    error,
    problem,
    phase,
    sent,
    saved,
    announcement,
    pending: phase !== "idle" || guard.pending,
    locked: sent || !access.write.allowed,
    updateField: (field: "model" | "complexity" | "reason", value: string) =>
      update({ ...latest.current.draft, [field]: value }),
    move,
    preview,
    save,
    setConfirmation,
    close: guard.requestClose,
  };
}
