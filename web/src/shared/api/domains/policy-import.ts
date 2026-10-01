import { z } from "zod";
import { operation, route, type WithQuery } from "@/shared/api/endpoint-factory";
import type {
  GetAdminPoliciesExportData,
  PostAdminPoliciesImportData,
  PostAdminPoliciesImportResponses,
  PolicyImportPolicy,
  PolicyImportRule,
  PolicyImportRequest,
} from "@/shared/api/generated";
import { ExactPolicyNumber, importProblem, policyImportLimits } from "./policy-import-json";

export type ImportRule = PolicyImportRule;
export type ImportPolicy = PolicyImportPolicy;
export interface PolicyImportBody extends PolicyImportRequest {
  version?: number;
  count?: number;
}
export interface PolicyExport {
  version: 1;
  count: number;
  policies: ImportPolicy[];
}
const plan = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    action: z.enum(["create", "update"]),
    rules: z.number().int().min(0).max(10000),
  })
  .strict();
export const policyImportAckSchema = z
  .object({
    dry_run: z.boolean(),
    created: z.number().int().min(0).max(1000),
    updated: z.number().int().min(0).max(1000),
    plan: z.array(plan).max(1000),
  })
  .strict();
export type PolicyImportAck = z.infer<typeof policyImportAckSchema>;
export const policyImportEndpoints = {
  apply: operation<
    WithQuery<PostAdminPoliciesImportData, { dry_run?: "1" }>,
    PostAdminPoliciesImportResponses[200]
  >()(
    "POST",
    "/admin/policies/import",
    policyImportAckSchema,
    z.object({ dry_run: z.literal("1").optional() }).strict(),
  ),
  export: route<GetAdminPoliciesExportData>()("GET", "/admin/policies/export"),
};
const policyKeys = new Set([
  "id",
  "name",
  "description",
  "enabled",
  "priority",
  "rollout_percent",
  "created_at",
  "updated_at",
  "rules",
]);
const ruleKeys = new Set([
  "id",
  "policy_id",
  "name",
  "enabled",
  "priority",
  "conditions",
  "actions",
  "rollout_percent",
  "created_at",
  "updated_at",
]);
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof ExactPolicyNumber)
    return importProblem("정책 JSON의 객체 형식을 확인하세요.");
  return value as Record<string, unknown>;
};
function exportedFields(row: Record<string, unknown>, required: Iterable<string>) {
  // A backup must be complete: import defaults are not evidence of exported values.
  for (const key of required) {
    if (!Object.hasOwn(row, key) || row[key] === null || row[key] === undefined)
      importProblem("현재 정책 내보내기 응답의 필수 값을 확인할 수 없습니다.");
  }
}
function fields(row: Record<string, unknown>, allowed: Set<string>) {
  if (Object.keys(row).some((key) => !allowed.has(key)))
    importProblem("지원하지 않는 상위 필드가 있습니다. 무시하지 않고 가져오기를 중단했습니다.");
  for (const key of ["id", "name", "description", "policy_id", "created_at", "updated_at"]) {
    if (row[key] !== undefined && row[key] !== null && typeof row[key] !== "string")
      importProblem("정책 문자열 필드 형식을 확인하세요.");
  }
  if (row.enabled !== undefined && row.enabled !== null && typeof row.enabled !== "boolean")
    importProblem("사용 상태는 참 또는 거짓이어야 합니다.");
  for (const key of ["priority", "rollout_percent"]) {
    if (
      row[key] !== undefined &&
      row[key] !== null &&
      (typeof row[key] !== "number" || !Number.isSafeInteger(row[key]))
    )
      importProblem("우선순위와 적용 비율은 안전한 정수여야 합니다.");
  }
}
const nonblank = (value: unknown) =>
  typeof value === "string" && value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "") !== "";
export function validatePolicyDocument(value: unknown, exported = false): PolicyImportBody {
  const doc = record(value);
  fields(doc, new Set(["policies", "version", "count"]));
  if (doc.version !== undefined && doc.version !== 1) importProblem("지원하는 정책 파일 버전은 1입니다.");
  if (!Array.isArray(doc.policies) || (!exported && doc.policies.length === 0))
    importProblem("가져올 정책이 없습니다.");
  if (!exported && doc.policies.length > policyImportLimits.policies)
    importProblem("한 번에 정책 1,000개까지 가져올 수 있습니다.");
  if (doc.count !== undefined && doc.count !== doc.policies.length)
    importProblem("정책 파일의 개수와 내용이 일치하지 않습니다.");
  if (exported && (doc.version !== 1 || doc.count !== doc.policies.length))
    importProblem("현재 정책 내보내기 응답을 확인할 수 없습니다.");
  const ids = new Set<string>();
  const ruleIds = new Set<string>();
  let rules = 0;
  for (const item of doc.policies) {
    const policy = record(item);
    fields(policy, policyKeys);
    if (exported) exportedFields(policy, policyKeys);
    if (!nonblank(policy.id) || !nonblank(policy.name) || ids.has(policy.id as string))
      importProblem("정책 ID와 이름은 비어 있지 않아야 하며 ID가 중복될 수 없습니다.");
    ids.add(policy.id as string);
    if (exported && !Array.isArray(policy.rules))
      importProblem("현재 내보내기 응답의 규칙 목록을 확인할 수 없습니다.");
    if (policy.rules === undefined || policy.rules === null) continue;
    if (!Array.isArray(policy.rules)) importProblem("규칙은 배열, null 또는 생략으로 지정하세요.");
    rules += policy.rules.length;
    if (!exported && rules > policyImportLimits.rules)
      importProblem("한 번에 명시 규칙 10,000개까지 가져올 수 있습니다.");
    for (const raw of policy.rules) {
      const rule = record(raw);
      fields(rule, ruleKeys);
      if (exported)
        exportedFields(rule, [
          "id",
          "policy_id",
          "name",
          "enabled",
          "priority",
          "conditions",
          "actions",
          "created_at",
          "updated_at",
        ]);
      if (!nonblank(rule.id) || ruleIds.has(rule.id as string))
        importProblem("규칙 ID는 비어 있지 않아야 하며 중복될 수 없습니다.");
      ruleIds.add(rule.id as string);
      if (rule.policy_id != null && rule.policy_id !== "" && rule.policy_id !== policy.id)
        importProblem("규칙의 소유 정책을 확인하세요.");
      for (const key of ["conditions", "actions"]) if (rule[key] != null) record(rule[key]);
    }
  }
  return doc as unknown as PolicyImportBody;
}
export function confirmPolicyAck(value: unknown, body: PolicyImportBody, dryRun: boolean): PolicyImportAck {
  const parsed = policyImportAckSchema.safeParse(value);
  if (!parsed.success) return importProblem("정책 가져오기 응답을 확인할 수 없습니다.");
  const result = parsed.data;
  const byId = new Map(body.policies.map((policy) => [policy.id, policy]));
  const ids = new Set(result.plan.map((row) => row.id));
  if (
    result.dry_run !== dryRun ||
    result.plan.length !== body.policies.length ||
    ids.size !== byId.size ||
    result.created !== result.plan.filter((row) => row.action === "create").length ||
    result.updated !== result.plan.filter((row) => row.action === "update").length ||
    result.plan.some(
      (row) =>
        !byId.has(row.id) ||
        row.name !== byId.get(row.id)?.name ||
        row.rules !== (byId.get(row.id)?.rules?.length ?? 0),
    )
  )
    return importProblem("정책 가져오기 응답의 대상과 개수를 확인할 수 없습니다.");
  return result;
}
