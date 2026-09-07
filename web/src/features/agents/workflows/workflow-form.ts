import { z } from "zod";

import type { Workflow, WorkflowUpsertBody } from "@/shared/api/domains/agents.schemas";

/** Step types the server accepts (`workflowStepTypes` in internal/proxy/admin_workflows.go). */
export const workflowStepTypes = [
  "chat",
  "text2sql",
  "mcp_tool",
  "skill",
  "condition",
  "approval",
  "transform",
] as const;

export const workflowStepTypeLabels: Record<(typeof workflowStepTypes)[number], string> = {
  chat: "채팅",
  text2sql: "Text2SQL",
  mcp_tool: "MCP 도구",
  skill: "Skill",
  condition: "조건",
  approval: "승인",
  transform: "변환",
};

const stepSchema = z.object({
  name: z.string().optional(),
  type: z.string(),
  ref: z.string().optional(),
  timeout_ms: z.number().optional(),
  max_cost_krw: z.number().optional(),
  max_tokens: z.number().optional(),
  allowed_tools: z.array(z.string()).optional(),
  allowed_tables: z.array(z.string()).optional(),
  note: z.string().optional(),
});

export const workflowStepsExample = JSON.stringify(
  [
    { name: "요청 정리", type: "transform", note: "입력을 표준 형식으로 정리" },
    { name: "초안 작성", type: "chat", ref: "vibe/auto", max_tokens: 800, timeout_ms: 30000 },
    { name: "담당자 승인", type: "approval" },
  ],
  null,
  2,
);

export const workflowFormSchema = z
  .object({
    name: z.string().trim().min(1, "워크플로 이름을 입력하세요."),
    description: z.string(),
    allowed_teams: z.string(),
    enabled: z.boolean(),
    steps: z.string(),
  })
  .superRefine((values, ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(values.steps) as unknown;
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["steps"],
        message: "단계 정의가 올바른 JSON이 아닙니다.",
      });
      return;
    }
    const result = z.array(stepSchema).safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({
        code: "custom",
        path: ["steps"],
        message: "단계는 name/type을 가진 객체 배열이어야 합니다.",
      });
      return;
    }
    if (result.data.length === 0) {
      ctx.addIssue({ code: "custom", path: ["steps"], message: "단계를 최소 1개 정의하세요." });
      return;
    }
    const allowed = new Set<string>(workflowStepTypes);
    const invalid = result.data.find((step) => !allowed.has(step.type.trim()));
    if (invalid) {
      ctx.addIssue({
        code: "custom",
        path: ["steps"],
        message: `허용되지 않는 단계 종류입니다: ${invalid.type}. 사용 가능: ${workflowStepTypes.join(", ")}`,
      });
    }
  })
  .transform((values) => ({
    name: values.name.trim(),
    description: values.description.trim(),
    allowed_teams: values.allowed_teams.trim(),
    enabled: values.enabled,
    steps: z.array(stepSchema).parse(JSON.parse(values.steps)),
  }));

export type WorkflowFormInput = z.input<typeof workflowFormSchema>;
export type WorkflowFormOutput = z.output<typeof workflowFormSchema>;

export function workflowFormDefaults(workflow?: Workflow): WorkflowFormInput {
  return {
    name: workflow?.name ?? "",
    description: workflow?.description ?? "",
    allowed_teams: workflow?.allowed_teams ?? "",
    enabled: workflow?.enabled ?? true,
    steps: JSON.stringify(workflow?.steps ?? [], null, 2),
  };
}

export function workflowUpsertBody(values: WorkflowFormOutput, id?: string): WorkflowUpsertBody {
  return {
    ...(id ? { id } : {}),
    name: values.name,
    description: values.description,
    allowed_teams: values.allowed_teams,
    enabled: values.enabled,
    steps: values.steps.map((step) => ({ ...step, name: step.name ?? "", type: step.type.trim() })),
  };
}

/** Case-insensitive match over the fields the list filter searches. */
export function matchesWorkflowQuery(workflow: Workflow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [workflow.name, workflow.description, workflow.allowed_teams, workflow.id].some((value) =>
    (value ?? "").toLowerCase().includes(needle),
  );
}
