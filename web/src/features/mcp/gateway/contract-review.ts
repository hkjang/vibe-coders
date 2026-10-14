import { z } from "zod";
import type { McpContract } from "@/shared/api/domains/mcp.schemas";
import type { McpContractBody } from "@/shared/api/domains/mcp";

const jsonSchema = z.string().refine((value) => {
  if (new TextEncoder().encode(value).length > 65536) return false;
  if (!value.trim()) return true;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}, "64KB 이하의 올바른 JSON을 입력하세요. 비우면 해당 선언을 제거합니다.");
export const contractFormSchema = z.object({
  id: z.string(),
  namespace: z.string().trim(),
  name: z.string().trim().min(1, "도구 이름을 입력하세요."),
  title: z.string(),
  description: z.string(),
  risk_level: z
    .string()
    .refine((value) => ["low", "medium", "high"].includes(value), "지원하는 위험도를 직접 선택하세요."),
  timeout_ms: z
    .string()
    .trim()
    .refine(
      (value) => value === "" || (/^\d+$/u.test(value) && Number.isSafeInteger(Number(value))),
      "0 이상 9,007,199,254,740,991 이하의 정수를 입력하세요.",
    ),
  allowed_roles: z.string(),
  cost_policy: z.string(),
  owner: z.string(),
  input_schema: jsonSchema,
  output_schema: jsonSchema,
  enabled: z.boolean(),
});
export type ContractDraft = z.infer<typeof contractFormSchema>;
export function contractAddressableID(id: string): boolean {
  // Match Go TrimSpace boundaries without changing the selected identity.
  if (!id || /^\p{White_Space}|\p{White_Space}$/u.test(id) || /\p{Cc}/u.test(id)) return false;
  try {
    encodeURIComponent(id);
    return true;
  } catch {
    return false;
  }
}
export const emptyContract: ContractDraft = {
  id: "",
  namespace: "gateway",
  name: "",
  title: "",
  description: "",
  risk_level: "low",
  timeout_ms: "",
  allowed_roles: "",
  cost_policy: "",
  owner: "",
  input_schema: "",
  output_schema: "",
  enabled: true,
};
export function contractDraft(original?: McpContract): ContractDraft {
  if (!original) return { ...emptyContract };
  return {
    id: original.id,
    namespace: original.namespace,
    name: original.name,
    title: original.title,
    description: original.description,
    risk_level: original.risk_level,
    timeout_ms: String(original.timeout_ms),
    allowed_roles: original.allowed_roles,
    cost_policy: original.cost_policy,
    owner: original.owner,
    input_schema: original.input_schema,
    output_schema: original.output_schema,
    enabled: original.enabled,
  };
}
export function contractBody(draft: ContractDraft): McpContractBody {
  return {
    ...(draft.id ? { id: draft.id } : {}),
    namespace: draft.namespace.trim() || "gateway",
    name: draft.name.trim(),
    title: draft.title.trim(),
    description: draft.description.trim(),
    risk_level: draft.risk_level,
    timeout_ms: Number(draft.timeout_ms),
    allowed_roles: draft.allowed_roles.trim(),
    cost_policy: draft.cost_policy.trim(),
    owner: draft.owner.trim(),
    input_schema: draft.input_schema.trim(),
    output_schema: draft.output_schema.trim(),
    enabled: draft.enabled,
  };
}
export const contractFields = [
  ["namespace", "네임스페이스"],
  ["name", "도구 이름"],
  ["title", "표시 제목"],
  ["description", "설명"],
  ["risk_level", "위험도"],
  ["timeout_ms", "타임아웃(ms)"],
  ["allowed_roles", "허용 역할"],
  ["cost_policy", "비용 정책"],
  ["owner", "담당"],
  ["input_schema", "입력 스키마"],
  ["output_schema", "출력 스키마"],
  ["enabled", "사용 상태"],
] as const;
export function contractChanges(original: McpContract | undefined, draft: ContractDraft) {
  const before = original ? contractBody(contractDraft(original)) : undefined;
  const after = contractBody(draft);
  return contractFields.filter(([key]) => !before || before[key] !== after[key]);
}
export const validationLabel = (status: string) => {
  switch (status) {
    case "ok":
      return "입력 속성 일치";
    case "drift":
      return "입력 속성 차이";
    case "missing":
      return "도구 누락";
    case "not_checkable":
      return "검증 불가";
    default:
      return "알 수 없는 결과";
  }
};
export function contractFingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
}
