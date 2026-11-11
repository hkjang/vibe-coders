import { z } from "zod";
import { operation, type WithBody } from "@/shared/api/endpoint-factory";
import type {
  GetAdminGoldenPromptsData,
  GetAdminGoldenPromptsResponse,
  GetAdminGoldenWorkflowsData,
  GetAdminGoldenWorkflowsResponse,
  PostAdminGoldenPromptsData,
  PostAdminGoldenPromptsResponse,
  PostAdminGoldenWorkflowsData,
  PostAdminGoldenWorkflowsResponse,
  GoldenPromptWriteBody,
  GoldenWorkflowWriteBody,
} from "@/shared/api/generated";

const tags = z.array(z.string()).nullable();
const promptSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  prompt: z.string(),
  expected: z.string(),
  tags,
  created_at: z.string(),
  updated_at: z.string(),
});
export const goldenResultSchema = z.object({
  id: z.string().min(1),
  prompt_id: z.string().min(1),
  model: z.string(),
  score: z.number().finite().min(0).max(1),
  passed: z.boolean(),
  cost_krw: z.number().finite().nonnegative(),
  latency_ms: z.number().int().nonnegative(),
  response: z.string(),
  created_at: z.string(),
});
const stepSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  expected: z.string(),
  task_type: z.string().optional(),
  selected_model: z.string().optional(),
  baseline_score: z.number().finite().optional(),
  contract_id: z.string().optional(),
  rubric_id: z.string().optional(),
  source_run_id: z.string().optional(),
});
const workflowSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  steps: z.array(stepSchema).nullable(),
  tags,
  created_at: z.string(),
  updated_at: z.string(),
});
const uniqueIDs = (rows: readonly { id: string }[]) =>
  new Set(rows.map((row) => row.id)).size === rows.length;
export const goldenPromptListSchema = z.object({
  golden_prompts: z.array(promptSchema).refine(uniqueIDs),
  results: z.array(goldenResultSchema).refine(uniqueIDs),
  run_revisions: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).optional(),
});
export const goldenWorkflowListSchema = z.object({
  workflows: z.array(workflowSchema).refine(uniqueIDs),
  run_revisions: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).optional(),
});
export type GoldenPrompt = z.infer<typeof promptSchema>;
export type GoldenResult = z.infer<typeof goldenResultSchema>;
export type GoldenWorkflow = z.infer<typeof workflowSchema>;
export type GoldenStep = z.infer<typeof stepSchema>;
type PromptDefinitionBody = Pick<GoldenPromptWriteBody, "id" | "name" | "prompt" | "expected" | "tags">;
type WorkflowDefinitionBody = Pick<GoldenWorkflowWriteBody, "id" | "name" | "description" | "steps" | "tags">;

export const goldenEndpoints = {
  savePrompt: operation<
    WithBody<PostAdminGoldenPromptsData, PromptDefinitionBody>,
    PostAdminGoldenPromptsResponse
  >()(
    "POST",
    "/admin/golden-prompts",
    z.object({ golden_prompt: promptSchema, results: z.array(goldenResultSchema) }),
  ),
  saveWorkflow: operation<
    WithBody<PostAdminGoldenWorkflowsData, WorkflowDefinitionBody>,
    PostAdminGoldenWorkflowsResponse
  >()("POST", "/admin/golden-workflows", workflowSchema),
  prompts: operation<GetAdminGoldenPromptsData, GetAdminGoldenPromptsResponse>()(
    "GET",
    "/admin/golden-prompts",
    goldenPromptListSchema,
    z.object({ prompt_id: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }),
  ),
  workflows: operation<GetAdminGoldenWorkflowsData, GetAdminGoldenWorkflowsResponse>()(
    "GET",
    "/admin/golden-workflows",
    goldenWorkflowListSchema,
  ),
} as const;
