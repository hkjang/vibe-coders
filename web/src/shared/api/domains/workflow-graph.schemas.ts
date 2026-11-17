import { z } from "zod";
import type { WorkflowGraphFlow, WorkflowGraphStep, WorkflowGraphInput } from "@/shared/api/generated";

const withinBytes = (value: string, limit: number): boolean =>
  new TextEncoder().encode(value).length <= limit;

export const workflowGraphConditionSchema = z.object({
  operator: z.enum(["non_empty", "equals", "contains"]),
  value: z.string().optional(),
});
export const workflowGraphFlowSchema = z.object({
  version: z.literal(1),
  entry: z.string(),
  edges: z
    .array(z.object({ from: z.string(), to: z.string(), when: z.enum(["next", "true", "false"]) }))
    .max(256),
}) satisfies z.ZodType<WorkflowGraphFlow>;
export const workflowGraphStepSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
  name: z.string(),
  type: z.enum(["chat", "skill", "text2sql", "mcp_tool", "condition", "approval", "transform"]),
  ref: z.string().optional(),
  note: z.string().optional(),
  condition: workflowGraphConditionSchema.optional(),
  timeout_ms: z.number().int().min(0).max(300000).optional(),
  max_tokens: z.number().int().min(0).max(1000000).optional(),
  max_cost_krw: z.literal(0).optional(),
  allowed_tools: z.array(z.string()).optional(),
  allowed_tables: z.array(z.string()).max(0).optional(),
}) satisfies z.ZodType<WorkflowGraphStep>;
export const workflowGraphInputSchema = z.object({
  id: z.string().min(1),
  name: z
    .string()
    .trim()
    .min(1, "워크플로 이름을 입력하세요.")
    .refine((value) => withinBytes(value, 800), "이름이 너무 깁니다. 최대 800바이트입니다."),
  description: z
    .string()
    .refine((value) => withinBytes(value, 8000), "설명이 너무 깁니다. 최대 8,000바이트입니다."),
  allowed_teams: z
    .string()
    .trim()
    .refine((value) => withinBytes(value, 8000), "허용 팀 목록이 너무 깁니다. 최대 8,000바이트입니다."),
  enabled: z.boolean(),
  steps: z.array(workflowGraphStepSchema).min(1).max(128),
  flow: workflowGraphFlowSchema,
}) satisfies z.ZodType<WorkflowGraphInput>;

export type GraphStep = z.output<typeof workflowGraphStepSchema>;
export type GraphFlow = z.output<typeof workflowGraphFlowSchema>;
export type GraphInput = z.output<typeof workflowGraphInputSchema>;
