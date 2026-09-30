import type { RoutingCostEstimate } from "@/shared/api/domains/routing";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { formatKRW, formatNumber } from "@/shared/utils/format";

export interface CostDraft {
  model: string;
  inputTokens: string;
  maxTokens: string;
}
export type CostField = keyof CostDraft;
export type CostErrors = Partial<Record<CostField, string>>;
export interface CostSnapshot {
  readonly draft: Readonly<CostDraft>;
  readonly body: { model: string; input_tokens: number; max_tokens: number };
}
export type CostState =
  | { kind: "idle" }
  | { kind: "pending" | "withheld"; snapshot: CostSnapshot }
  | { kind: "success"; snapshot: CostSnapshot; result: RoutingCostEstimate }
  | { kind: "error"; snapshot: CostSnapshot; message: string; requestId?: string };
export const emptyCostDraft: CostDraft = { model: "", inputTokens: "1000", maxTokens: "600" };
export const costFieldOrder: readonly CostField[] = ["model", "inputTokens", "maxTokens"];
export const hiddenCostValue = "민감정보가 포함될 수 있어 표시하지 않습니다.";

export function prepareCostDraft(draft: CostDraft): { errors: CostErrors; snapshot?: CostSnapshot } {
  const errors: CostErrors = {};
  if (!draft.model.trim()) errors.model = "모델을 입력하세요.";
  // Empty strings keep the existing explicit zero wire semantics.
  const input = Number(draft.inputTokens.trim());
  const max = Number(draft.maxTokens.trim());
  if (!Number.isSafeInteger(input) || input < 0)
    errors.inputTokens = "입력 토큰은 0 이상의 안전한 정수로 입력하세요.";
  if (!Number.isSafeInteger(max) || max < 0)
    errors.maxTokens = "최대 출력 토큰은 0 이상의 안전한 정수로 입력하세요.";
  if (Object.keys(errors).length) return { errors };
  return {
    errors,
    snapshot: {
      draft: { ...draft },
      body: { model: draft.model.trim(), input_tokens: input, max_tokens: max },
    },
  };
}
export function costDraftChanged(draft: CostDraft, snapshot: CostSnapshot): boolean {
  return costFieldOrder.some((field) => draft[field] !== snapshot.draft[field]);
}
export function costText(value: string | undefined, prefixes: readonly string[]): string {
  return value && containsPotentialSecret(value, prefixes) ? hiddenCostValue : value || "—";
}
export function costBasis(value: string, prefixes: readonly string[]): string {
  if (containsPotentialSecret(value, prefixes)) return hiddenCostValue;
  switch (value) {
    case "history":
      return "과거 사용량 기준";
    case "max_tokens":
      return "입력한 출력 토큰 기준";
    case "default":
      return "기본 출력 토큰 기준";
    default:
      return value || "확인할 수 없음";
  }
}
export function estimatedCost(result: RoutingCostEstimate): string {
  return result.priced === true && Number.isFinite(result.cost_krw) && result.cost_krw >= 0
    ? formatKRW(result.cost_krw)
    : "확인할 수 없음";
}
export function estimatedLatency(result: RoutingCostEstimate): string {
  return result.basis === "history" && Number.isFinite(result.latency_ms) && result.latency_ms >= 0
    ? `${formatNumber(result.latency_ms)}ms`
    : "확인할 수 없음";
}
