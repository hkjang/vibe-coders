import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { z } from "zod";
import { AppError } from "@/shared/api/error";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import type { LLMReadOwner } from "./llm-read-access";
import type { LLMReadLifetime } from "./llm-read-lifetime";
import { useLLMFeedback } from "./use-llm-feedback";

import { useUnsavedChanges } from "@/shared/unsaved/context";

/** Retired private inputs stay in memory, not hidden fields or browser storage. */
function useRetainedFeedbackGuard(retained: boolean, discard: () => void) {
  const coordinator = useUnsavedChanges();
  const [owner] = useState(() => Symbol("retained-llm-feedback"));
  const latest = useRef(discard);
  useLayoutEffect(() => {
    latest.current = discard;
  }, [discard]);
  useLayoutEffect(() => {
    if (retained)
      coordinator?.setForm(owner, {
        dirty: true,
        // A retired transmission may still finish; discarding UI never cancels it.
        pending: false,
        discard: () => latest.current(),
      });
    else coordinator?.removeForm(owner);
    return () => coordinator?.removeForm(owner);
  }, [coordinator, owner, retained]);
  return () => coordinator?.requestClose(owner);
}

const schema = z.object({
  request_id: z.string().trim().min(1, "요청 ID를 입력하세요."),
  rating: z.coerce.number().int().min(-1).max(1),
  label: z.string().trim().max(64).optional(),
  comment: z.string().trim().max(1000).optional(),
});
const defaults = { request_id: "", rating: 1, label: "", comment: "" };
interface Target {
  requestId: string;
  traceId: string;
  owner: LLMReadOwner;
  instance: number;
}

export function useLLMFeedbackDraft(
  lifetime: LLMReadLifetime,
  assertWrite: () => void,
  canWrite: boolean,
  returnFocusRef: RefObject<HTMLElement | null>,
) {
  const { owner, principal } = lifetime;
  const form = useZodForm<z.input<typeof schema>, z.output<typeof schema>>(schema, defaults);
  const operation = useLLMFeedback(owner, assertWrite, principal);
  const [target, setTarget] = useState<Target>();
  const active = useRef<Target | undefined>(undefined);
  const sequence = useRef(0);
  useLayoutEffect(
    () => () => {
      active.current = undefined;
    },
    [],
  );
  const retained = Boolean(target && (target.owner !== owner || lifetime.denied));
  const outcome = operation.outcome?.instance === target?.instance ? operation.outcome?.outcome : undefined;
  const close = (instance: number | undefined) => {
    if (!principal.isCurrent() || !active.current || active.current.instance !== instance) return;
    const previous = active.current;
    active.current = undefined;
    operation.forget(previous.instance);
    setTarget((current) => (current === previous ? undefined : current));
    form.reset(defaults);
  };
  const discard = useRetainedFeedbackGuard(retained, () => close(target?.instance));
  const open = (requestId: string, traceId: string, trigger?: HTMLElement) => {
    if (!canWrite || !owner.isCurrent() || active.current) return;
    const next = { requestId, traceId, owner, instance: ++sequence.current };
    active.current = next;
    returnFocusRef.current = trigger ?? null;
    setTarget(next);
    form.reset({ ...defaults, request_id: requestId });
  };
  const recovery =
    retained && target
      ? {
          requestId: form.getValues().request_id.trim(),
          resume: (traceId: string) => {
            if (!owner.isCurrent() || active.current !== target) return;
            const next = { ...target, owner, traceId };
            active.current = next;
            setTarget(next);
          },
        }
      : undefined;
  return {
    form,
    target,
    retained,
    outcome,
    canRetry: Boolean(outcome && operation.canRetry),
    returnFocusRef,
    open,
    recovery,
    discard,
    shown: target?.owner === owner,
    close: () => close(target?.instance),
    submit: async (values: z.output<typeof schema>) => {
      if (!target || active.current !== target || target.owner !== owner || !owner.isCurrent())
        throw new AppError("종료된 피드백 편집입니다.", { kind: "aborted" });
      await operation.mutateAsync(values, target.traceId, target.instance);
    },
  };
}
export type LLMFeedbackDraft = ReturnType<typeof useLLMFeedbackDraft>;
