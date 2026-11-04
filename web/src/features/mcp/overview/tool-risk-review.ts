import { z } from "zod";
import type { McpToolRisk } from "@/shared/api/domains/mcp.schemas";
import { decisionLabel, riskLabel } from "@/features/mcp/mcp-utils";

export const riskLevelChoices = ["low", "medium", "high", "critical"].map((value) => ({
  value,
  label: riskLabel(value),
}));
export const actionChoices = ["allow", "require_approval", "block"].map((value) => ({
  value,
  label: decisionLabel(value),
}));
export const riskFormSchema = z.object({
  risk_level: z.enum(["low", "medium", "high", "critical"], { error: "지원하는 위험 등급을 선택하세요." }),
  action: z.enum(["allow", "require_approval", "block"], { error: "지원하는 조치를 선택하세요." }),
  note: z.string().trim().max(500, "메모는 500자까지 입력할 수 있습니다."),
});
// Strings retain an unknown server value until the user explicitly replaces it.
export interface RiskDraft {
  risk_level: string;
  action: string;
  note: string;
}
export function riskSnapshot(row: McpToolRisk) {
  return JSON.stringify([
    row.server_label,
    row.tool_name,
    row.configured,
    row.risk_level,
    row.action,
    row.note,
  ]);
}
export function riskChanges(row: McpToolRisk, draft: RiskDraft) {
  const fields = [
    {
      id: "risk_level",
      label: "위험 등급",
      before: row.risk_level,
      after: draft.risk_level,
      format: riskLabel,
    },
    { id: "action", label: "조치", before: row.action, after: draft.action, format: decisionLabel },
    {
      id: "note",
      label: "메모",
      before: row.note,
      after: draft.note.trim(),
      format: (v: string) => v || "없음",
    },
  ];
  const changes = fields
    .filter((field) => field.before !== field.after)
    .map((field) => ({
      id: field.id,
      label: field.label,
      before: field.format(field.before),
      after: field.format(field.after),
    }));
  if (!row.configured)
    changes.unshift({
      id: "configured",
      label: "설정 방식",
      before: "추론된 기본값",
      after: "이 도구의 고정 설정",
    });
  return changes;
}
