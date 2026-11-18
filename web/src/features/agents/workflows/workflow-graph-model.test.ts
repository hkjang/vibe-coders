import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "@/shared/api/generated";
import {
  addGraphStep,
  changeGraphType,
  graphDraft,
  graphEnd,
  graphIssues,
  graphRequestWithinLimit,
  removeGraphStep,
} from "./workflow-graph-model";
import { workflowGraphInputSchema } from "@/shared/api/domains/workflow-graph.schemas";

const legacy: WorkflowDefinition = {
  id: "legacy",
  name: "기존 업무",
  description: "",
  enabled: true,
  allowed_teams: "team",
  created_by: "owner",
  created_at: "",
  updated_at: "",
  steps: [
    { name: "조건", type: "condition" },
    { name: "도구", type: "mcp_tool", ref: "server__echo", max_cost_krw: 100, allowed_tables: ["records"] },
  ],
};
describe("분기 편집 모델", () => {
  it("실행 의미가 바뀌는 전환은 중지하고 명시적인 참·거짓·종료 연결을 만든다", () => {
    const draft = graphDraft(legacy);
    expect(draft.enabled).toBe(false);
    expect(draft.flow.edges).toEqual([
      { from: "step_1", to: "step_2", when: "true" },
      { from: "step_1", to: graphEnd, when: "false" },
      { from: "step_2", to: graphEnd, when: "next" },
    ]);
    expect(draft.steps[1]).toMatchObject({ type: "mcp_tool", ref: "server__echo" });
    expect(draft.steps[1]).not.toHaveProperty("max_cost_krw");
    expect(graphIssues(draft)).toEqual([]);
    expect(legacy.enabled).toBe(true);
  });
  it("순환·도달 불가·삭제된 연결을 저장 가능한 경로로 취급하지 않는다", () => {
    const draft = graphDraft(legacy);
    const cycle = structuredClone(draft);
    const edge = cycle.flow.edges[2];
    if (!edge) throw new Error("Missing fixture edge");
    edge.to = "step_1";
    expect(graphIssues(cycle).join(" ")).toContain("순환");
    expect(graphIssues(addGraphStep(draft)).join(" ")).toContain("도달할 수 없는");
    expect(graphIssues(removeGraphStep(draft, "step_2")).join(" ")).toContain("연결 대상이 없습니다");
    expect(graphIssues(removeGraphStep(draft, "step_1")).join(" ")).toContain("시작 단계");
  });
  it("종류를 바꿀 때 보이지 않는 기존 참조와 조건이 실행되지 않게 한다", () => {
    const result = changeGraphType(graphDraft(legacy), "step_2", "condition");
    expect(result.steps[1]).not.toHaveProperty("ref");
    expect(result.steps[1]?.condition).toEqual({ operator: "non_empty" });
    expect(result.flow.edges.filter((edge) => edge.from === "step_2")).toHaveLength(2);
  });
  it("기존 분기의 ID와 연결 및 사용 상태를 다시 열 때 보존한다", () => {
    const draft = graphDraft(legacy);
    draft.enabled = true;
    expect(graphDraft({ ...legacy, ...draft })).toEqual(draft);
  });
  it("한글 이름과 설명은 글자 수가 아닌 서버의 UTF-8 한도를 따른다", () => {
    const draft = graphDraft(legacy);
    expect(workflowGraphInputSchema.safeParse({ ...draft, name: "가".repeat(266) }).success).toBe(true);
    expect(workflowGraphInputSchema.safeParse({ ...draft, name: "가".repeat(267) }).success).toBe(false);
    expect(workflowGraphInputSchema.safeParse({ ...draft, description: "가".repeat(2667) }).success).toBe(
      false,
    );
    expect(workflowGraphInputSchema.safeParse({ ...draft, allowed_teams: "x".repeat(8001) }).success).toBe(
      false,
    );
  });
  it("긴 단계 메모와 JSON 이스케이프까지 요청 크기에 포함한다", () => {
    const draft = graphDraft(legacy);
    expect(graphRequestWithinLimit(draft, "검토", "a".repeat(64))).toBe(true);
    const first = draft.steps[0];
    if (!first) throw new Error("Missing step");
    first.note = "가".repeat(100000);
    expect(graphRequestWithinLimit(draft, "검토", "a".repeat(64))).toBe(false);
    first.note = "\\".repeat(140000);
    expect(graphRequestWithinLimit(draft, "검토", "a".repeat(64))).toBe(false);
  });
});
