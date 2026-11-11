import { z } from "zod";
import { operation, type WithBody } from "@/shared/api/endpoint-factory";
import type {
  GoldenPromptRunBody,
  GoldenWorkflowRunBody,
  GoldenRunReview,
  PostAdminGoldenPromptsRunReviewedData,
  PostAdminGoldenPromptsRunReviewedResponse,
  PostAdminGoldenWorkflowsRunReviewedData,
  PostAdminGoldenWorkflowsRunReviewedResponse,
} from "@/shared/api/generated";
import { goldenResultSchema } from "./golden";

const count = z.number().int().nonnegative();
const rate = z.number().finite().min(0).max(1);
const cost = z.number().finite().nonnegative();
const runError = z.enum([
  "request_encoding_failed",
  "provider_unavailable",
  "upstream_configuration_invalid",
  "upstream_request_invalid",
  "upstream_request_failed",
  "upstream_request_timeout",
  "upstream_response_read_failed",
  "upstream_non_success_status",
]);
const summary = z.object({
  total: count,
  passed: count,
  failed: count,
  pass_rate: rate,
  min_pass_rate: rate,
  regressed: z.boolean(),
  planned_total: count.min(1).max(64),
  complete: z.boolean(),
  max_output_tokens: count.min(1).max(4096),
  timeout_seconds: z.literal(120),
});
const unique = (values: string[]) => new Set(values).size === values.length;
function validSummary(value: z.infer<typeof summary>) {
  return (
    value.total === value.passed + value.failed &&
    value.total <= value.planned_total &&
    (!value.complete || value.total === value.planned_total) &&
    Math.abs(value.pass_rate - (value.total ? value.passed / value.total : 1)) < 1e-9 &&
    value.regressed === (value.total > 0 && value.pass_rate < value.min_pass_rate)
  );
}
export const goldenPromptRunSchema = summary
  .extend({
    results: z.array(goldenResultSchema).max(64),
    failures: z
      .array(z.object({ prompt_id: z.string(), name: z.string(), model: z.string(), score: rate }))
      .max(64),
    execution_errors: z.record(z.string(), runError),
    results_saved: z.boolean(),
  })
  .refine(
    (value) =>
      validSummary(value) &&
      value.results.length === value.total &&
      value.results.filter((row) => row.passed).length === value.passed &&
      value.failures.length === value.failed &&
      new Set(value.results.map((row) => row.id)).size === value.results.length &&
      unique(value.results.map((row) => JSON.stringify([row.prompt_id, row.model]))) &&
      unique(value.failures.map((row) => JSON.stringify([row.prompt_id, row.model]))) &&
      Object.keys(value.execution_errors).every((id) =>
        value.results.some((row) => row.id === id && !row.passed),
      ) &&
      value.failures.every((failure) =>
        value.results.some(
          (row) =>
            !row.passed &&
            row.prompt_id === failure.prompt_id &&
            row.model === failure.model &&
            row.score === failure.score,
        ),
      ),
  );
export const goldenWorkflowRunSchema = summary
  .extend({
    workflow_id: z.string().min(1),
    workflow_name: z.string(),
    steps: z
      .array(
        z.object({
          step: count.min(1),
          name: z.string(),
          model: z.string(),
          score: rate,
          passed: z.boolean(),
          cost_krw: cost,
          latency_ms: count,
          error: runError.or(z.literal("")),
        }),
      )
      .max(64),
    failures: z
      .array(z.object({ step: count.min(1), name: z.string(), model: z.string(), score: rate }))
      .max(64),
  })
  .refine(
    (value) =>
      validSummary(value) &&
      value.steps.length === value.total &&
      value.steps.filter((row) => row.passed).length === value.passed &&
      value.failures.length === value.failed &&
      unique(value.steps.map((row) => JSON.stringify([row.step, row.model]))) &&
      unique(value.failures.map((row) => JSON.stringify([row.step, row.model]))) &&
      value.steps.every((row) => !row.error || !row.passed) &&
      value.failures.every((failure) =>
        value.steps.some(
          (row) =>
            !row.passed &&
            row.step === failure.step &&
            row.model === failure.model &&
            row.score === failure.score,
        ),
      ),
  );
export type GoldenPromptRun = z.infer<typeof goldenPromptRunSchema>;
export type GoldenWorkflowRun = z.infer<typeof goldenWorkflowRunSchema>;
export type ReviewedPromptRunBody = Pick<GoldenPromptRunBody, "models" | "min_pass_rate"> & {
  prompt_ids: string[];
  review: GoldenRunReview;
};
export type ReviewedWorkflowRunBody = Pick<GoldenWorkflowRunBody, "id" | "models" | "min_pass_rate"> & {
  review: GoldenRunReview;
};

export const goldenRunEndpoints = {
  runPrompts: operation<
    WithBody<PostAdminGoldenPromptsRunReviewedData, ReviewedPromptRunBody>,
    PostAdminGoldenPromptsRunReviewedResponse
  >()("POST", "/admin/golden-prompts/run-reviewed", goldenPromptRunSchema),
  runWorkflow: operation<
    WithBody<PostAdminGoldenWorkflowsRunReviewedData, ReviewedWorkflowRunBody>,
    PostAdminGoldenWorkflowsRunReviewedResponse
  >()("POST", "/admin/golden-workflows/run-reviewed", goldenWorkflowRunSchema),
} as const;
