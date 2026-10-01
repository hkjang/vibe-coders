import type { RoutingRule } from "@/shared/api/domains/routing";
import type { RoutingEditInput } from "@/shared/api/domains/routing-edit";
import { AppError } from "@/shared/api/error";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { sameRoutingRule, toggleIdentityReason } from "./routing-toggle-state";

export const editFields = [
  ["match_pattern", "모델 패턴"],
  ["target_model", "대상 모델"],
  ["target_provider", "대상 공급자"],
  ["min_complexity", "최소 복잡도"],
  ["max_complexity", "최대 복잡도"],
  ["priority", "우선순위"],
  ["note", "메모"],
] as const;
export type EditField = (typeof editFields)[number][0];
export type RuleEdit = Partial<Record<EditField, string>>;
export const protectedRuleText = "민감정보가 포함될 수 있어 표시하지 않습니다.";
export const changedRuleMessage = "원본 규칙이 변경되었습니다. 목록을 다시 조회한 뒤 다시 편집하세요.";
export function ruleText(value: string, prefixes: readonly string[], empty = "없음") {
  return containsPotentialSecret(value, prefixes) ? protectedRuleText : value || empty;
}
export function editIdentityReason(rule: RoutingRule) {
  return toggleIdentityReason(rule.id) ? "원본 규칙 ID를 안전한 수정 경로로 표현할 수 없습니다." : undefined;
}
export class RuleEditProblem extends Error {
  constructor(
    public field: EditField,
    message: string,
  ) {
    super(message);
  }
}
export function assertRuleBaseline(rows: readonly RoutingRule[], baseline: RoutingRule) {
  const matches = rows.filter((row) => row.id === baseline.id);
  if (matches.length !== 1 || !sameRoutingRule(matches[0], baseline))
    throw new AppError(changedRuleMessage, { kind: "contract", code: "routing_edit_source_changed" });
}
export function buildRulePatch(
  baseline: RoutingRule,
  edit: RuleEdit,
  prefixes: readonly string[],
): RoutingEditInput {
  const patch: RoutingEditInput = {};
  for (const [field] of editFields) {
    const raw = edit[field];
    if (raw === undefined || raw === String(baseline[field])) continue;
    if (field === "priority" || field === "min_complexity" || field === "max_complexity") {
      const value = Number(raw);
      const maximum = field === "priority" ? 10_000 : 100;
      const minimum = field === "priority" ? 1 : 0;
      if (!raw.trim() || !Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new RuleEditProblem(field, `${minimum}부터 ${maximum} 사이의 정수를 입력하세요.`);
      if (value !== baseline[field]) patch[field] = value;
      continue;
    }
    if (containsPotentialSecret(raw, prefixes))
      throw new RuleEditProblem(
        field,
        "새 민감정보로 보이는 값은 저장하지 않습니다. 입력을 지우고 다시 작성하세요.",
      );
    // Match Go strings.TrimSpace: NEL is whitespace; FEFF is not.
    const trimmed = raw.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
    const value = field === "match_pattern" ? trimmed || "*" : trimmed;
    if (field === "target_model" && !value) throw new RuleEditProblem(field, "대상 모델을 입력하세요.");
    const maximum =
      field === "match_pattern"
        ? 200
        : field === "target_provider"
          ? 120
          : field === "note"
            ? 500
            : undefined;
    if (maximum !== undefined && value.length > maximum)
      throw new RuleEditProblem(field, `${maximum}자 이하로 입력하세요.`);
    if (value !== baseline[field]) patch[field] = value;
  }
  const minimum = patch.min_complexity ?? baseline.min_complexity;
  const maximum = patch.max_complexity ?? baseline.max_complexity;
  if (minimum < 0 || maximum > 100 || minimum > maximum)
    throw new RuleEditProblem(
      "min_complexity",
      "복잡도 범위는 0부터 100 사이이며 최소값이 최대값보다 클 수 없습니다.",
    );
  return patch;
}
export function ruleAcknowledged(rule: RoutingRule, baseline: RoutingRule, patch: RoutingEditInput) {
  // Omitted fields can legitimately change concurrently. The ACK is not a CAS
  // or an attribution guarantee for a later GET.
  return (
    rule.id === baseline.id &&
    editFields.every(([field]) => patch[field] === undefined || rule[field] === patch[field])
  );
}
