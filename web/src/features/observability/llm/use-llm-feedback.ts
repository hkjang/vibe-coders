import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { assertLLMReadOwner, llmReadError } from "./llm-read-query";
import { ownsLLMQuery, type LLMReadOwner } from "./llm-read-access";

interface FeedbackValues {
  request_id: string;
  rating: number;
  label?: string;
  comment?: string;
}
export type FeedbackOutcome = "pending" | "acknowledged" | "uncertain";
interface Transmission {
  instance: number;
  outcome: FeedbackOutcome;
  owner: LLMReadOwner;
}

/** No shared mutation cache retains private form values or publishes across read owners. */
export function useLLMFeedback(owner: LLMReadOwner, assertWrite: () => void, principal = owner) {
  const client = useQueryClient();
  const operation = useRef<Transmission | undefined>(undefined);
  const [outcome, setOutcome] = useState<Transmission>();
  const canRetry = (sent: Transmission) =>
    sent.owner === owner && sent.outcome === "uncertain" && owner.isCurrent();
  const mutateAsync = async (values: FeedbackValues, traceId: string, instance: number): Promise<void> => {
    assertLLMReadOwner(owner);
    assertWrite();
    if (operation.current?.instance === instance && !canRetry(operation.current))
      throw new AppError("이미 전송한 피드백입니다. 현재 결과를 확인하고 새 편집을 시작하세요.", {
        kind: "contract",
      });
    const sent: Transmission = { instance, outcome: "pending", owner };
    operation.current = sent;
    setOutcome({ ...sent });
    const publishOutcome = () => {
      if (operation.current === sent && principal.isCurrent()) setOutcome({ ...sent });
    };
    const assertOperation = () => {
      assertLLMReadOwner(owner);
      if (operation.current !== sent) throw new AppError("종료된 피드백 편집입니다.", { kind: "aborted" });
    };
    try {
      await apiClient.request(endpoints.domains.observability.llm.submitFeedback, {
        body: {
          request_id: values.request_id,
          rating: values.rating,
          ...(traceId ? { trace_id: traceId } : {}),
          ...(values.label ? { label: values.label } : {}),
          ...(values.comment ? { comment: values.comment } : {}),
          source: "console",
        },
        routeId: "observability.llm.feedback.create",
        retryUnauthorized: false,
      });
      sent.outcome = "acknowledged";
      publishOutcome();
      assertOperation();
      await client.invalidateQueries({
        predicate: ({ queryKey }) =>
          ownsLLMQuery(queryKey, owner) && (queryKey[2] === "feedback" || queryKey[2] === "trace"),
      });
      assertOperation();
      toast.success("피드백을 등록했습니다.");
    } catch (cause) {
      if (sent.outcome === "pending") sent.outcome = "uncertain";
      publishOutcome();
      assertOperation();
      const error = llmReadError(cause, owner);
      toast.error("피드백을 등록하지 못했습니다.", {
        description: error.requestId ? `요청 ID: ${error.requestId}` : undefined,
      });
      throw error;
    }
  };
  return {
    mutateAsync,
    outcome,
    // Preserve uncertainty for later retirement; only an explicit same-lease retry may replace it.
    canRetry: Boolean(outcome && canRetry(outcome)),
    forget: (instance: number) => {
      if (!principal.isCurrent()) return;
      if (operation.current?.instance === instance) operation.current = undefined;
      setOutcome((previous) => (previous?.instance === instance ? undefined : previous));
    },
  };
}
