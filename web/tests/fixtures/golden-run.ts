import type { GoldenPromptRun, GoldenWorkflowRun } from "../../src/shared/api/domains/golden-run";
import { goldenPrompts, goldenResults, goldenWorkflows } from "./golden-regression";

export const promptRevisions = Object.fromEntries(goldenPrompts.map((row) => [row.id, "a".repeat(64)]));
export const workflowRevisions = Object.fromEntries(goldenWorkflows.map((row) => [row.id, "b".repeat(64)]));
export const promptRun: GoldenPromptRun = {
  total: 2,
  passed: 1,
  failed: 1,
  pass_rate: 0.5,
  min_pass_rate: 1,
  regressed: true,
  planned_total: 2,
  complete: true,
  max_output_tokens: 512,
  timeout_seconds: 120,
  results: goldenResults.map((row) => ({ ...row, prompt_id: "public-prompt-a" })),
  failures: [{ prompt_id: "public-prompt-a", name: "한글 답변 확인", model: "public-model-a", score: 0.5 }],
  execution_errors: {},
  results_saved: true,
};
export const workflowRun: GoldenWorkflowRun = {
  total: 2,
  passed: 1,
  failed: 1,
  pass_rate: 0.5,
  min_pass_rate: 1,
  regressed: true,
  planned_total: 2,
  complete: true,
  max_output_tokens: 512,
  timeout_seconds: 120,
  workflow_id: "public-workflow-a",
  workflow_name: "모델 교체 검증",
  steps: [
    {
      step: 1,
      name: "첫 번째 검사",
      model: "public-model-a",
      score: 1,
      passed: true,
      cost_krw: 0,
      latency_ms: 0,
      error: "",
    },
    {
      step: 2,
      name: "두 번째 검사",
      model: "public-model-a",
      score: 0,
      passed: false,
      cost_krw: 0,
      latency_ms: 100,
      error: "upstream_request_failed",
    },
  ],
  failures: [{ step: 2, name: "두 번째 검사", model: "public-model-a", score: 0 }],
};
