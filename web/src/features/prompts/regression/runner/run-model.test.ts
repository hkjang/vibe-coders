import { expect, it } from "vitest";
import { goldenPrompts, goldenWorkflows } from "../../../../../tests/fixtures/golden-regression";
import {
  promptRevisions,
  promptRun,
  workflowRevisions,
  workflowRun,
} from "../../../../../tests/fixtures/golden-run";
import { makeRunPlan, projectRunReceipt, runSchema, validateRunReceipt, type RunCatalog } from "./run-model";
import { compareRunModels, runRows } from "./run-results";
import { hiddenText } from "../regression-model";

const input = {
  ids: ["public-prompt-a"],
  models: "public-model-a\npublic-model-b",
  passRate: "100",
  maxCalls: "64",
  outputTokens: "512",
};
const catalog: RunCatalog = { kind: "prompt", rows: goldenPrompts, revisions: promptRevisions };
const firstPrompt = goldenPrompts[0];
const secondResult = promptRun.results[1];
if (!firstPrompt || !secondResult) throw new Error("public fixture missing");
it("모델 중복을 정규화하고 호출 수·검토 정의를 입력과 독립적으로 보존한다", () => {
  const values = runSchema.parse({ ...input, models: " public-model-a \npublic-model-b\npublic-model-a\n" });
  const plan = makeRunPlan(catalog, values, []);
  expect(plan.calls).toBe(2);
  expect(plan.values.models).toEqual(["public-model-a", "public-model-b"]);
  expect(plan.definitions).toEqual({ "public-prompt-a": "a".repeat(64) });
  values.ids.push("later");
  expect(plan.values.ids).toEqual(["public-prompt-a"]);
  expect(plan.targets[0]?.checks[0]?.prompt).toBe("안녕하세요라고 답하세요.");
});
it.each([
  { maxCalls: "0" },
  { maxCalls: "65" },
  { maxCalls: "1.2" },
  { outputTokens: "4097" },
  { outputTokens: "" },
  { passRate: "" },
  { passRate: "-1" },
  { passRate: "101" },
  { models: "" },
  { ids: [] },
  { ids: ["a", "a"] },
])("잘못된 입력을 거부한다: %j", (override) => {
  expect(runSchema.safeParse({ ...input, ...override }).success).toBe(false);
});
it("검토 정보 없는 서버·변경된 선택·호출 초과·숨긴 입력·비밀 모델명을 차단한다", () => {
  const values = runSchema.parse(input);
  expect(() => makeRunPlan({ ...catalog, revisions: undefined }, values, [])).toThrow();
  expect(() => makeRunPlan(catalog, { ...values, ids: ["missing"] }, [])).toThrow();
  expect(() => makeRunPlan(catalog, { ...values, maxCalls: 1 }, [])).toThrow();
  expect(() => makeRunPlan(catalog, { ...values, models: ["corp_" + "x".repeat(40)] }, ["corp_"])).toThrow();
  const row = firstPrompt;
  expect(() => makeRunPlan({ ...catalog, rows: [{ ...row, prompt: hiddenText }] }, values, [])).toThrow();
});
it("워크플로 단계 수와 모델 수로 실행 범위를 계산하고 여러 워크플로 선택을 거부한다", () => {
  const workflows: RunCatalog = { kind: "workflow", rows: goldenWorkflows, revisions: workflowRevisions };
  const values = runSchema.parse({ ...input, ids: ["public-workflow-a"] });
  expect(makeRunPlan(workflows, values, []).calls).toBe(4);
  expect(() => makeRunPlan(workflows, { ...values, maxCalls: 3 }, [])).toThrow();
  expect(() => makeRunPlan(workflows, { ...values, ids: Object.keys(workflowRevisions) }, [])).toThrow();
});
it("응답이 검토한 대상·모델·한도와 일치해야 비교한다", () => {
  const plan = makeRunPlan(catalog, runSchema.parse(input), []);
  expect(() => validateRunReceipt(plan, promptRun)).not.toThrow();
  for (const changed of [
    { ...promptRun, planned_total: 3 },
    { ...promptRun, max_output_tokens: 1024 },
    { ...promptRun, min_pass_rate: 0.5 },
    { ...promptRun, results: promptRun.results.map((row) => ({ ...row, model: "unexpected" })) },
  ])
    expect(() => validateRunReceipt(plan, changed)).toThrow();
  expect(() => validateRunReceipt(plan, workflowRun)).toThrow();
});
it("미실행 모델은 0원·통과율 0으로 표시하지 않으며 실제 0은 보존한다", () => {
  const plan = makeRunPlan(catalog, runSchema.parse(input), []);
  const receipt = {
    kind: "prompt" as const,
    plan,
    receivedAt: 0,
    result: { ...promptRun, results: [secondResult] },
  };
  const comparison = compareRunModels(receipt);
  expect(comparison[0]).toMatchObject({ count: 0, cost: undefined, latency: undefined, passRate: undefined });
  expect(comparison[1]).toMatchObject({ count: 1, cost: 0, latency: 0, passRate: 1, rateDelta: undefined });
});
it("실행 실패와 기대 내용 불일치를 구분하고 원문 비밀을 결과 상태에 남기지 않는다", () => {
  const plan = makeRunPlan(catalog, runSchema.parse(input), []);
  const receipt = projectRunReceipt(
    {
      kind: "prompt",
      plan,
      receivedAt: 0,
      result: {
        ...promptRun,
        results: promptRun.results.map((row) => ({ ...row, response: "corp_" + "x".repeat(40) })),
        execution_errors: { "public-result-a": "upstream_request_failed" },
      },
    },
    ["corp_"],
  );
  expect(JSON.stringify(receipt)).not.toContain("corp_" + "x".repeat(40));
  expect(runRows(receipt)[0]).toMatchObject({ passed: false, error: true });
});
