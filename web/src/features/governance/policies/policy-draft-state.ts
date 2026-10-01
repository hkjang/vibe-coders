import type { AdvisorApplyBody, PolicySuggestion } from "@/shared/api/domains/governance";
import { AppError } from "@/shared/api/error";
import type { SimulationWindow } from "./policy-simulation-state";

export interface PolicyDraftSnapshot {
  readonly window: SimulationWindow;
  readonly body: AdvisorApplyBody;
}
export function policyDraftSnapshot(row: PolicySuggestion, window: SimulationWindow): PolicyDraftSnapshot {
  // Keep existing nullish fallback and unmodified raw JSON. Do not normalize
  // title with JS trim (Go's whitespace rules and its default title differ).
  return {
    window,
    body: structuredClone({
      title: row.title ?? row.id,
      conditions: row.conditions ?? {},
      actions: row.actions ?? {},
    }),
  };
}
export function policyDraftAcknowledged(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "policy_id" in value &&
    typeof value.policy_id === "string" &&
    value.policy_id.trim().length > 0 &&
    "enabled" in value &&
    value.enabled === false
  );
}
/** Display only: match the existing Go TrimSpace/default title, never alter POST. */
export function policyDraftStoredName(title: string): string {
  return `[draft] ${title.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "") || "advisor 추천 정책"}`;
}
export const draftSourceReason = "추천 목록과 검토 기준을 다시 확인하세요.";
export function draftStopped(): AppError {
  return new AppError("종료되었거나 변경된 초안 검토입니다.", { kind: "aborted" });
}
