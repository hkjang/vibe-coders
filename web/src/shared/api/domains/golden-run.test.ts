import { expect, it } from "vitest";
import { promptRun, workflowRun } from "../../../../tests/fixtures/golden-run";
import { goldenPromptRunSchema, goldenWorkflowRunSchema } from "./golden-run";

it("기존 응답과 구분되는 검토 실행 응답을 검증한다", () => {
  expect(goldenPromptRunSchema.safeParse(promptRun).success).toBe(true);
  expect(goldenWorkflowRunSchema.safeParse(workflowRun).success).toBe(true);
  const legacy = { ...promptRun, complete: undefined };
  expect(goldenPromptRunSchema.safeParse(legacy).success).toBe(false);
});
it.each([
  { total: 1 },
  { passed: 2 },
  { planned_total: 1 },
  { planned_total: 3 },
  { pass_rate: 0.8 },
  { regressed: false },
  { timeout_seconds: 121 },
  { max_output_tokens: 4097 },
  { results: [...promptRun.results, promptRun.results[0]] },
  { results: promptRun.results.map((row) => ({ ...row, id: "same" })) },
  { results: promptRun.results.map((row) => ({ ...row, model: "same" })) },
  { execution_errors: { unknown: "upstream_request_failed" } },
  { execution_errors: { "public-result-b": "upstream_request_failed" } },
  { execution_errors: { "public-result-a": "raw private message" } },
  { failures: [] },
  { failures: [{ ...promptRun.failures[0], score: 0.1 }] },
])("모순되거나 안전하지 않은 프롬프트 응답을 거부한다: %j", (override) => {
  expect(goldenPromptRunSchema.safeParse({ ...promptRun, ...override }).success).toBe(false);
});
it("불완전한 실행은 완전 성공으로 표시하지 않는다", () => {
  expect(goldenPromptRunSchema.safeParse({ ...promptRun, planned_total: 4, complete: false }).success).toBe(
    true,
  );
  expect(
    goldenWorkflowRunSchema.safeParse({ ...workflowRun, planned_total: 4, complete: false }).success,
  ).toBe(true);
});
it.each([
  { steps: workflowRun.steps.map((row) => ({ ...row, step: 1 })) },
  { steps: workflowRun.steps.map((row) => ({ ...row, error: "upstream_request_failed" })) },
  { failures: [{ ...workflowRun.failures[0], step: 1 }] },
  { failures: [...workflowRun.failures, workflowRun.failures[0]] },
])("워크플로 결과 정합성을 검증한다: %j", (override) => {
  expect(goldenWorkflowRunSchema.safeParse({ ...workflowRun, ...override }).success).toBe(false);
});
