import { describe, expect, it } from "vitest";
import { goldenPromptListSchema, goldenWorkflowListSchema } from "@/shared/api/domains/golden";
import { goldenPrompts, goldenResults, goldenWorkflows } from "../../../../tests/fixtures/golden-regression";
import {
  canLinkRegressionID,
  hiddenText,
  projectPrompts,
  projectWorkflows,
  resultSummary,
} from "./regression-model";

const firstPrompt = goldenPrompts[0],
  firstResult = goldenResults[0],
  firstWorkflow = goldenWorkflows[0];
if (!firstPrompt || !firstResult || !firstWorkflow) throw new Error("공개 검증 데이터가 필요합니다.");

describe("회귀 조회 데이터 계약", () => {
  it("0점 통과와 실제 0원·0ms를 보존한다", () => {
    const data = goldenPromptListSchema.parse({ golden_prompts: goldenPrompts, results: goldenResults });
    expect(data.results[1]).toMatchObject({ score: 0, passed: true, cost_krw: 0, latency_ms: 0 });
    expect(resultSummary(data.results)).toEqual({ count: 2, passRate: 0.5, cost: 2.5, latency: 800 });
    expect(resultSummary([])).toEqual({ count: 0, passRate: undefined, cost: undefined, latency: undefined });
  });
  it.each([
    { golden_prompts: [], results: null },
    { golden_prompts: null, results: [] },
    { golden_prompts: [goldenPrompts[0], goldenPrompts[0]], results: [] },
    { golden_prompts: [], results: [goldenResults[0], goldenResults[0]] },
    { golden_prompts: [], results: [{ ...goldenResults[0], passed: "false" }] },
    { golden_prompts: [], results: [{ ...goldenResults[0], score: 90 }] },
    { golden_prompts: [], results: [{ ...goldenResults[0], cost_krw: -1 }] },
    { golden_prompts: [], results: [{ id: "public-partial" }] },
  ])("불완전·중복 결과를 정상 빈 데이터로 바꾸지 않는다 %#", (data) => {
    expect(goldenPromptListSchema.safeParse(data).success).toBe(false);
  });
  it("워크플로 순서·출처·점수 스케일과 null 단계를 유지한다", () => {
    const data = goldenWorkflowListSchema.parse({ workflows: goldenWorkflows });
    expect(data.workflows[0]?.steps?.map((step) => step.name)).toEqual(["첫 번째 검사", "두 번째 검사"]);
    expect(data.workflows[0]?.steps?.[0]).toMatchObject({
      baseline_score: 82.5,
      source_run_id: "public-source",
    });
    expect(data.workflows[1]?.steps).toBeNull();
    expect(goldenWorkflowListSchema.safeParse({ workflows: [{ id: "incomplete" }] }).success).toBe(false);
  });
  it("서버에서 받은 민감 텍스트를 조회 캐시 투입 전에 투영한다", () => {
    const secret = "corp_" + "x".repeat(40);
    const prompts = projectPrompts(
      {
        golden_prompts: [{ ...firstPrompt, name: secret, prompt: secret, expected: secret, tags: [secret] }],
        results: [{ ...firstResult, response: secret, model: secret }],
      },
      ["corp_"],
    );
    expect(JSON.stringify(prompts)).not.toContain(secret);
    expect(prompts.golden_prompts[0]?.prompt).toBe(hiddenText);
    const workflows = projectWorkflows(
      {
        workflows: [
          {
            ...firstWorkflow,
            name: secret,
            description: secret,
            tags: [secret],
            steps: [
              {
                name: secret,
                prompt: secret,
                expected: secret,
                source_run_id: secret,
                selected_model: secret,
                rubric_id: secret,
                contract_id: secret,
                task_type: secret,
              },
            ],
          },
        ],
      },
      ["corp_"],
    );
    expect(JSON.stringify(workflows)).not.toContain(secret);
  });
  it.each(["", " spaced ", "public\nvalue", "x".repeat(513), "corp_" + "x".repeat(40)])(
    "공유 주소에 부적절한 식별자를 넣지 않는다 %#",
    (id) => {
      expect(canLinkRegressionID(id, ["corp_"])).toBe(false);
    },
  );
});
