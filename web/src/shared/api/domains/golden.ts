import { z } from "zod";
import { operation } from "@/shared/api/endpoint-factory";
import type {
  GetAdminGoldenPromptsData,
  GetAdminGoldenPromptsResponse,
  GetAdminGoldenWorkflowsData,
  GetAdminGoldenWorkflowsResponse,
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
const resultSchema = z.object({
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
  results: z.array(resultSchema).refine(uniqueIDs),
});
export const goldenWorkflowListSchema = z.object({ workflows: z.array(workflowSchema).refine(uniqueIDs) });
export type GoldenPrompt = z.infer<typeof promptSchema>;
export type GoldenResult = z.infer<typeof resultSchema>;
export type GoldenWorkflow = z.infer<typeof workflowSchema>;
export type GoldenStep = z.infer<typeof stepSchema>;

export const goldenEndpoints = {
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
