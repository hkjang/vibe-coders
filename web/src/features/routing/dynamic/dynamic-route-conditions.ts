/**
 * The condition builder edits the common shape of a condition — a list of
 * comparisons that must all (or any) match — and falls back to raw JSON for
 * anything deeper. Converting back produces exactly the document the server reads.
 */

export type ConditionOperator = "$eq" | "$ne" | "$in" | "$nin" | "$gt" | "$gte" | "$lt" | "$lte" | "$exists";
export type ConditionValueType = "string" | "number" | "boolean";

export interface ConditionRule {
  field: string;
  op: ConditionOperator;
  value: string;
  valueType: ConditionValueType;
}

export interface SimpleConditions {
  mode: "all" | "any";
  rules: ConditionRule[];
}

export const conditionOperators: ReadonlyArray<{ value: ConditionOperator; label: string }> = [
  { value: "$eq", label: "같음 (=)" },
  { value: "$ne", label: "다름 (≠)" },
  { value: "$in", label: "목록 중 하나" },
  { value: "$nin", label: "목록에 없음" },
  { value: "$gt", label: "초과 (>)" },
  { value: "$gte", label: "이상 (≥)" },
  { value: "$lt", label: "미만 (<)" },
  { value: "$lte", label: "이하 (≤)" },
  { value: "$exists", label: "값 있음/없음" },
];

const numericOperators = new Set<ConditionOperator>(["$gt", "$gte", "$lt", "$lte"]);
const listOperators = new Set<ConditionOperator>(["$in", "$nin"]);

export function isNumericOperator(op: ConditionOperator): boolean {
  return numericOperators.has(op);
}

export function isListOperator(op: ConditionOperator): boolean {
  return listOperators.has(op);
}

function typeOf(value: unknown): ConditionValueType | undefined {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return undefined;
}

function ruleFrom(field: string, op: string, operand: unknown): ConditionRule | undefined {
  if (!conditionOperators.some((item) => item.value === op)) return undefined;
  const operator = op as ConditionOperator;
  if (operator === "$exists") {
    return typeof operand === "boolean"
      ? { field, op: operator, value: String(operand), valueType: "boolean" }
      : undefined;
  }
  if (listOperators.has(operator)) {
    if (!Array.isArray(operand) || operand.length === 0) return undefined;
    const valueType = typeOf(operand[0]);
    if (!valueType || operand.some((item) => typeOf(item) !== valueType)) return undefined;
    return { field, op: operator, value: operand.map(String).join(", "), valueType };
  }
  const valueType = typeOf(operand);
  return valueType ? { field, op: operator, value: String(operand), valueType } : undefined;
}

function rulesFromObject(object: Record<string, unknown>): ConditionRule[] | undefined {
  const rules: ConditionRule[] = [];
  for (const [field, value] of Object.entries(object)) {
    if (field.startsWith("$")) return undefined;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [op, operand] of Object.entries(value as Record<string, unknown>)) {
        const rule = ruleFrom(field, op, operand);
        if (!rule) return undefined;
        rules.push(rule);
      }
      continue;
    }
    const rule = ruleFrom(field, "$eq", value);
    if (!rule) return undefined;
    rules.push(rule);
  }
  return rules;
}

/** Reads a condition document into builder rows, or undefined when it is too deep for them. */
export function parseSimpleConditions(conditions: unknown): SimpleConditions | undefined {
  if (conditions === undefined) return { mode: "all", rules: [] };
  if (typeof conditions !== "object" || conditions === null || Array.isArray(conditions)) return undefined;
  const object = conditions as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length === 1 && (keys[0] === "$or" || keys[0] === "$and")) {
    const list = object[keys[0]];
    if (!Array.isArray(list)) return undefined;
    const rules: ConditionRule[] = [];
    for (const item of list) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
      const parsed = rulesFromObject(item as Record<string, unknown>);
      if (!parsed || parsed.length !== 1) return undefined;
      rules.push(...parsed);
    }
    return { mode: keys[0] === "$or" ? "any" : "all", rules };
  }
  const rules = rulesFromObject(object);
  return rules ? { mode: "all", rules } : undefined;
}

function coerce(value: string, valueType: ConditionValueType): string | number | boolean {
  const trimmed = value.trim();
  if (valueType === "number") return Number(trimmed);
  if (valueType === "boolean") return trimmed === "true";
  return trimmed;
}

function operand(rule: ConditionRule): unknown {
  if (rule.op === "$exists") return rule.value.trim() !== "false";
  if (listOperators.has(rule.op)) {
    return rule.value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "")
      .map((item) => coerce(item, rule.valueType));
  }
  if (numericOperators.has(rule.op)) return Number(rule.value.trim());
  return coerce(rule.value, rule.valueType);
}

/** Problems a rule has before it is sent; the server re-checks everything. */
export function ruleError(rule: ConditionRule): string | undefined {
  if (
    !/^(metadata\.[A-Za-z0-9_.:-]{1,64}|identity\.(team_id|team|user_id|api_key_id|role)|request\.(stream|endpoint))$/u.test(
      rule.field.trim(),
    )
  ) {
    return "필드는 metadata.<키>, identity.team 같은 형식이어야 합니다.";
  }
  if (rule.op === "$exists") return undefined;
  const value = rule.value.trim();
  if (value === "") return "비교할 값을 입력하세요.";
  const numeric = numericOperators.has(rule.op) || rule.valueType === "number";
  const values = listOperators.has(rule.op) ? value.split(",").map((item) => item.trim()) : [value];
  if (numeric && values.some((item) => item === "" || !Number.isFinite(Number(item))))
    return "숫자를 입력하세요.";
  if (rule.valueType === "boolean" && values.some((item) => item !== "true" && item !== "false"))
    return "true 또는 false를 입력하세요.";
  return undefined;
}

export function buildConditions(simple: SimpleConditions): Record<string, unknown> {
  const valid = simple.rules.filter((rule) => ruleError(rule) === undefined);
  if (simple.mode === "any" && valid.length > 1) {
    return { $or: valid.map((rule) => ({ [rule.field.trim()]: { [rule.op]: operand(rule) } })) };
  }
  const out: Record<string, Record<string, unknown>> = {};
  for (const rule of valid) {
    const field = rule.field.trim();
    out[field] = { ...out[field], [rule.op]: operand(rule) };
  }
  return out;
}

export function emptyRule(): ConditionRule {
  return { field: "metadata.", op: "$eq", value: "", valueType: "string" };
}
