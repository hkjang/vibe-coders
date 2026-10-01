import type { RoutingRule } from "@/shared/api/domains/routing";
import type { RoutingCreateInput } from "@/shared/api/domains/routing-create";
import { containsPotentialSecret } from "@/shared/security/secrets";

export const createFields = [
  ["match_pattern", "모델 패턴"],
  ["target_model", "대상 모델"],
  ["target_provider", "대상 공급자"],
  ["min_complexity", "최소 복잡도"],
  ["max_complexity", "최대 복잡도"],
  ["priority", "우선순위"],
  ["note", "메모"],
] as const;
export type CreateField = (typeof createFields)[number][0];
export type CreateDraft = Record<CreateField, string>;
export const initialCreateDraft: Readonly<CreateDraft> = Object.freeze({
  match_pattern: "*",
  target_model: "",
  target_provider: "",
  min_complexity: "0",
  max_complexity: "100",
  priority: "100",
  note: "",
});
export const createAcknowledgedMessage = "라우팅 규칙 생성 요청을 확인했습니다.";
export const protectedCreateText = "민감정보가 포함될 수 있어 표시하지 않습니다.";
export const createReviewChanged =
  "권한 또는 표시 보호 기준이 바뀌었습니다. 입력 수정으로 돌아가 다시 검토하세요.";

export class RuleCreateProblem extends Error {
  constructor(
    public field: CreateField,
    message: string,
  ) {
    super(message);
  }
}
export function createText(value: string | number, prefixes: readonly string[], empty = "없음") {
  const text = String(value);
  return containsPotentialSecret(text, prefixes) ? protectedCreateText : text || empty;
}
export function buildRuleCreate(draft: CreateDraft, prefixes: readonly string[]): RoutingCreateInput {
  const text = (field: "match_pattern" | "target_model" | "target_provider" | "note") => {
    const raw = draft[field];
    if (containsPotentialSecret(raw, prefixes))
      throw new RuleCreateProblem(field, "민감정보로 보이는 입력을 지우고 다시 작성하세요.");
    // Preserve the existing create form's JS trim, then reflect the server's
    // additional Go whitespace normalization (NEL, not FEFF) in the review.
    const normalized = raw.trim().replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
    const value = field === "match_pattern" ? normalized || "*" : normalized;
    const limit =
      field === "match_pattern"
        ? 200
        : field === "target_provider"
          ? 120
          : field === "note"
            ? 500
            : undefined;
    if (limit !== undefined && value.length > limit)
      throw new RuleCreateProblem(field, `${limit}자 이하로 입력하세요.`);
    if (field === "target_model" && !value) throw new RuleCreateProblem(field, "대상 모델을 입력하세요.");
    return value;
  };
  const number = (field: "min_complexity" | "max_complexity" | "priority") => {
    const raw = draft[field];
    const value = Number(raw);
    const minimum = field === "priority" ? 1 : 0;
    const maximum = field === "priority" ? 10_000 : 100;
    if (!raw.trim() || !Number.isSafeInteger(value) || value < minimum || value > maximum)
      throw new RuleCreateProblem(field, `${minimum}부터 ${maximum} 사이의 정수를 입력하세요.`);
    return value;
  };
  const result: RoutingCreateInput = {
    match_pattern: text("match_pattern"),
    target_model: text("target_model"),
    target_provider: text("target_provider"),
    min_complexity: number("min_complexity"),
    max_complexity: number("max_complexity"),
    priority: number("priority"),
    note: text("note"),
    enabled: true,
  };
  if (result.min_complexity > result.max_complexity)
    throw new RuleCreateProblem("min_complexity", "최소 복잡도는 최대 복잡도보다 클 수 없습니다.");
  return result;
}
export function createAcknowledged(rule: RoutingRule, body: Readonly<RoutingCreateInput>) {
  // The server may return the zero timestamp, and its ID fallback is not a
  // globally unique insertion guarantee. Do not infer a GET timestamp or CAS.
  return (
    rule.id.trim() !== "" &&
    rule.enabled === true &&
    createFields.every(([field]) => rule[field] === body[field])
  );
}
