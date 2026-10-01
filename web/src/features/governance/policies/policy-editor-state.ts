import type { Policy, PolicyBody, PolicyRule, PolicyRuleBody } from "@/shared/api/domains/governance";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { fingerprint, goTrim, protectedJson } from "./policy-editor-security";

export type EditValue = { replacement?: string };
export interface RuleEdit {
  key: number;
  original?: PolicyRule;
  removed: boolean;
  name: EditValue;
  enabled: boolean | undefined;
  priority: string;
  conditions: EditValue;
  actions: EditValue;
}
export interface PolicyEdit {
  name: EditValue;
  description: EditValue;
  priority: string;
  rules: RuleEdit[];
  emptyConfirmed: boolean;
}
export class EditProblem extends Error {
  constructor(
    public field: string,
    message: string,
  ) {
    super(message);
  }
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value !== 0;
}
export function policyProblem(policy: Policy): string | undefined {
  if (!policy.id || goTrim(policy.id) !== policy.id)
    return "정책 ID가 저장 시 바뀌므로 이 정책을 안전하게 편집할 수 없습니다.";
  if (policy.enabled !== false) return "비활성 상태가 확인된 정책만 편집할 수 있습니다.";
  if (
    typeof policy.name !== "string" ||
    typeof policy.description !== "string" ||
    !integer(policy.priority) ||
    !Number.isSafeInteger(policy.rollout_percent) ||
    Number(policy.rollout_percent) < 1 ||
    Number(policy.rollout_percent) > 100 ||
    (policy.rules !== undefined && !Array.isArray(policy.rules))
  )
    return "정책 원본의 이름·설명·우선순위·적용 비율·규칙을 확인할 수 없습니다. 값을 추정하여 저장하지 않습니다.";
  return undefined;
}
export function newRule(key: number): RuleEdit {
  return {
    key,
    removed: false,
    name: { replacement: "" },
    enabled: true,
    priority: "100",
    conditions: { replacement: "{}" },
    actions: { replacement: "{}" },
  };
}
export function initialEdit(policy: Policy): PolicyEdit {
  return {
    name: {},
    description: {},
    priority: String(policy.priority ?? ""),
    emptyConfirmed: false,
    rules: (policy.rules ?? []).map((rule, key) => ({
      key,
      original: rule,
      removed: false,
      name: {},
      enabled: rule.enabled,
      priority: String(rule.priority ?? ""),
      conditions: {},
      actions: {},
    })),
  };
}
export function resolvedText(edit: EditValue, original: unknown): string {
  return edit.replacement ?? (typeof original === "string" ? original : "");
}
function text(edit: EditValue, original: unknown, field: string, prefixes: readonly string[]): string {
  if (edit.replacement === undefined && typeof original !== "string")
    throw new EditProblem(field, "원본을 확인할 수 없습니다. 전체 교체를 선택하세요.");
  const value = resolvedText(edit, original);
  if (edit.replacement !== undefined && containsPotentialSecret(value, prefixes))
    throw new EditProblem(
      field,
      "새 민감정보로 보이는 값은 저장하지 않습니다. 입력을 지우고 다시 작성하세요.",
    );
  const normalized = goTrim(value);
  if (edit.replacement === undefined && containsPotentialSecret(value, prefixes) && normalized !== value)
    throw new EditProblem(
      field,
      "보호된 원문이 저장 시 정리됩니다. 원문을 유지할 수 없어 전체 교체가 필요합니다.",
    );
  return normalized;
}
function priority(value: string, field: string): number {
  const parsed = Number(value);
  if (!value.trim() || !integer(parsed))
    throw new EditProblem(field, "0이 아닌 안전한 정수를 입력하세요. 음수는 허용합니다.");
  return parsed;
}
function validJson(value: unknown): boolean {
  if (typeof value === "number")
    return Number.isFinite(value) && (Number.isInteger(value) ? Number.isSafeInteger(value) : true);
  if (Array.isArray(value)) return value.every(validJson);
  if (value && typeof value === "object") return Object.values(value).every(validJson);
  return value === null || ["string", "boolean"].includes(typeof value);
}
function json(
  edit: EditValue,
  original: unknown,
  field: string,
  prefixes: readonly string[],
): Record<string, unknown> {
  let value: unknown = original;
  if (edit.replacement !== undefined) {
    try {
      value = JSON.parse(edit.replacement);
    } catch {
      throw new EditProblem(field, "올바른 JSON 객체를 입력하세요. 오류에 원문을 표시하지 않습니다.");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || !validJson(value))
    throw new EditProblem(
      field,
      "유한한 숫자와 안전한 정수를 사용하는 JSON 객체가 필요합니다. 전체 교체로 수정할 수 있습니다.",
    );
  if (Object.keys(value).some((key) => key !== goTrim(key).toLowerCase()))
    throw new EditProblem(
      field,
      "최상위 키의 공백·대문자가 서버에서 바뀝니다. 이 JSON을 전체 교체하거나 규칙을 삭제하세요.",
    );
  if (edit.replacement !== undefined && protectedJson(value, prefixes))
    throw new EditProblem(
      field,
      "새 민감정보로 보이는 JSON은 저장하지 않습니다. 입력을 지우고 다시 작성하세요.",
    );
  return value as Record<string, unknown>;
}
export function buildPolicy(policy: Policy, edit: PolicyEdit, prefixes: readonly string[]): PolicyBody {
  const problem = policyProblem(policy);
  if (problem) throw new EditProblem("policy", problem);
  const seen = new Set<string>();
  const rules = edit.rules
    .filter((rule) => !rule.removed)
    .map((rule) => {
      const field = `rule-${rule.key}`;
      if (
        rule.original &&
        (!rule.original.id || goTrim(rule.original.id) !== rule.original.id || seen.has(rule.original.id))
      )
        throw new EditProblem(
          field,
          "규칙 ID를 그대로 유지할 수 없습니다. 규칙 전체 교체 또는 삭제를 선택하세요.",
        );
      if (rule.original?.id) seen.add(rule.original.id);
      if (typeof rule.enabled !== "boolean")
        throw new EditProblem(
          field,
          "규칙의 사용 상태를 확인할 수 없습니다. 규칙 전체 교체 또는 삭제를 선택하세요.",
        );
      return {
        ...(rule.original ? { id: rule.original.id } : {}),
        name: text(rule.name, rule.original?.name, `${field}-name`, prefixes),
        enabled: rule.enabled,
        priority: priority(rule.priority, `${field}-priority`),
        conditions: json(rule.conditions, rule.original?.conditions, `${field}-conditions`, prefixes),
        actions: json(rule.actions, rule.original?.actions, `${field}-actions`, prefixes),
      } satisfies PolicyRuleBody;
    });
  if (!rules.length && (policy.rules?.length ?? 0) > 0 && !edit.emptyConfirmed)
    throw new EditProblem("empty", "규칙을 모두 비우는 변경을 명시적으로 확인하세요.");
  return {
    id: policy.id,
    name: text(edit.name, policy.name, "name", prefixes) || policy.id,
    description: text(edit.description, policy.description, "description", prefixes),
    enabled: false,
    priority: priority(edit.priority, "priority"),
    rollout_percent: Number(policy.rollout_percent),
    rules,
  };
}
export function originalBody(policy: Policy): unknown {
  return {
    id: policy.id,
    name: policy.name,
    description: policy.description,
    enabled: policy.enabled,
    priority: policy.priority,
    rollout_percent: policy.rollout_percent,
    rules: (policy.rules === undefined ? [] : policy.rules)?.map((rule) => ({
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled,
      priority: rule.priority,
      conditions: rule.conditions,
      actions: rule.actions,
    })),
  };
}
export function changed(policy: Policy, body: PolicyBody): boolean {
  return fingerprint(originalBody(policy)) !== fingerprint(body);
}
export function acknowledged(policy: Policy | undefined, body: PolicyBody): boolean {
  if (
    !policy ||
    policy.id !== body.id ||
    policy.enabled !== false ||
    (policy.rules !== undefined && !Array.isArray(policy.rules))
  )
    return false;
  const actual = originalBody(policy) as PolicyBody;
  const ids = new Set<string>();
  for (const rule of actual.rules) {
    if (typeof rule.id !== "string" || !rule.id || goTrim(rule.id) !== rule.id || ids.has(rule.id))
      return false;
    ids.add(rule.id);
  }
  return (
    fingerprint({ ...actual, rules: actual.rules.map((rule) => ({ ...rule, id: undefined })) }) ===
      fingerprint({ ...body, rules: body.rules.map((rule) => ({ ...rule, id: undefined })) }) &&
    body.rules.every((rule, index) => !rule.id || rule.id === actual.rules[index]?.id)
  );
}
