import { z } from "zod";

import { sandboxKinds, type SandboxPreview, type SandboxPreviewBody } from "@/shared/api/domains/security";

export const sandboxKindLabels: Record<string, string> = {
  chat: "Chat",
  text2sql: "Text2SQL",
  mcp: "MCP 도구",
};

export const sandboxFormSchema = z.object({
  kind: z.enum(sandboxKinds),
  model: z.string().trim().max(200, "200자 이내로 입력하세요."),
  provider: z.string().trim().max(200, "200자 이내로 입력하세요."),
  team: z.string().trim().max(200, "200자 이내로 입력하세요."),
  server: z.string().trim().max(200, "200자 이내로 입력하세요."),
  tool: z.string().trim().max(200, "200자 이내로 입력하세요."),
  content: z.string().max(20_000, "20,000자 이내로 입력하세요."),
  sql: z.string().trim().max(20_000, "20,000자 이내로 입력하세요."),
});

export type SandboxFormValues = z.infer<typeof sandboxFormSchema>;

export const sandboxFormDefaults: SandboxFormValues = {
  kind: "chat",
  model: "",
  provider: "",
  team: "",
  server: "",
  tool: "",
  content: "",
  sql: "",
};

/** Drops empty optional fields so the gateway sees the same body the legacy form sent. */
export function sandboxRequestBody(values: SandboxFormValues): SandboxPreviewBody {
  const body: SandboxPreviewBody = { kind: values.kind };
  if (values.model) body.model = values.model;
  if (values.provider) body.provider = values.provider;
  if (values.team) body.team = values.team;
  if (values.server) body.server = values.server;
  if (values.tool) body.tool = values.tool;
  if (values.content) body.content = values.content;
  if (values.sql) body.sql = values.sql;
  return body;
}

/** Go omits empty slices as null on some gates, so lists are read defensively. */
function joined(values: readonly string[] | null | undefined, prefix: string, suffix = ""): string {
  return values && values.length > 0 ? `${prefix}${values.join(", ")}${suffix}` : "";
}

export interface SandboxCheckRow {
  label: string;
  value: string;
}

/** The gate results the legacy screen listed, in the same order and wording. */
export function sandboxCheckRows(preview: SandboxPreview): SandboxCheckRow[] {
  const checks = preview.checks;
  if (!checks) return [];
  const rows: SandboxCheckRow[] = [];
  const injection = checks.prompt_injection;
  if (injection) {
    rows.push({
      label: "프롬프트 인젝션",
      value: `심각도 ${injection.severity}${joined(injection.families, " · ")}`,
    });
  }
  const secrets = checks.secrets;
  if (secrets) {
    rows.push({ label: "Secret 탐지", value: `${secrets.count}건${joined(secrets.types, " (", ")")}` });
  }
  const policy = checks.policy;
  if (policy) {
    rows.push({
      label: "정책",
      value: policy.reason ? `${policy.outcome} — ${policy.reason}` : policy.outcome,
    });
  }
  const sql = checks.text2sql_validation;
  if (sql) {
    rows.push({ label: "SQL 검증", value: sql.ok ? "통과" : `실패: ${sql.reason}` });
  }
  const tool = checks.mcp_tool_risk;
  if (tool) {
    rows.push({ label: "MCP 도구 위험", value: `${tool.risk_level} / ${tool.action}` });
  }
  return rows;
}
