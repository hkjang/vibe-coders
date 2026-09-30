import { useCallback, useLayoutEffect, useRef } from "react";
import { toast } from "sonner";

import { apiClient } from "@/shared/api/client";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { runActionLabels, type RunActionSnapshot, type RunActionValues } from "./run-action-state";
import { chatRouteId } from "./use-chat-console";
import type { CompareAccess } from "./use-compare-access";

const chat = endpoints.domains.gateway.chat;
const abandoned = () => new AppError("현재 실행 작업을 다시 확인하세요.", { kind: "aborted" });

/** One dialog instance owns its target and flight, including after async validation. */
export function useRunActionSubmit(snapshot: RunActionSnapshot, access: CompareAccess) {
  const target = useRef(snapshot).current;
  const mounted = useRef(false);
  const flight = useRef<symbol | undefined>(undefined);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flight.current = undefined;
    };
  }, []);

  return useCallback(
    async (values: RunActionValues): Promise<void> => {
      if (!mounted.current || !access.isCurrent()) throw abandoned();
      access.write.assertCurrent();
      if (!target.runId || !target.models.includes(values.model))
        throw new AppError("이 실행의 모델과 대상을 다시 확인하세요.", { kind: "contract" });
      if (flight.current) throw new AppError("이미 저장 중입니다.", { kind: "aborted" });
      const current = Symbol("run-action");
      flight.current = current;
      const owned = () => mounted.current && access.isCurrent() && flight.current === current;
      const assertSending = () => {
        if (!owned()) throw abandoned();
        access.write.assertCurrent();
      };
      try {
        // Build the immutable body before the final, synchronous admission check.
        if (target.kind === "feedback") {
          const body = {
            model: values.model,
            rating: Number(values.rating),
            label: values.label || undefined,
            comment: values.comment || undefined,
          };
          assertSending();
          await apiClient.request(withPathParams(chat.multiRunFeedback, { id: target.runId }), {
            body,
            routeId: chatRouteId,
          });
        } else if (target.kind === "promote") {
          const body = {
            model: values.model,
            task_type: values.task_type || undefined,
            reason: values.reason,
          };
          assertSending();
          await apiClient.request(withPathParams(chat.multiRunPromote, { id: target.runId }), {
            body,
            routeId: chatRouteId,
          });
        } else {
          const body = {
            selected_model: values.model,
            workflow_id: values.workflow_id || undefined,
            workflow_name: values.workflow_name || undefined,
            step_name: values.step_name || undefined,
            task_type: values.task_type || undefined,
            expected: values.expected || undefined,
            prompt: target.prompt.trim() || undefined,
          };
          assertSending();
          await apiClient.request(withPathParams(chat.multiRunGolden, { id: target.runId }), {
            body,
            routeId: chatRouteId,
          });
        }
        // Readonly/scope changes do not turn an admitted write into a failed save.
        if (!owned()) throw abandoned();
        toast.success(runActionLabels[target.kind].success);
      } catch (cause) {
        if (!owned()) throw abandoned();
        throw cause; // FormDialog owns the current inline error and request ID.
      } finally {
        if (owned()) flight.current = undefined;
      }
    },
    [access, target],
  );
}
