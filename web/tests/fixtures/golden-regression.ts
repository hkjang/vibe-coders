import type { GoldenPrompt, GoldenResult, GoldenWorkflow } from "../../src/shared/api/domains/golden";

export const goldenPrompts: GoldenPrompt[] = [
  {
    id: "public-prompt-a",
    name: "한글 답변 확인",
    prompt: "안녕하세요라고 답하세요.",
    expected: "안녕하세요",
    tags: ["기본", "한글"],
    created_at: "2030-01-01T00:00:00Z",
    updated_at: "2030-01-02T00:00:00Z",
  },
  {
    id: "public-prompt-b",
    name: "빈 기대 내용 확인",
    prompt: "자유롭게 답하세요.",
    expected: "",
    tags: null,
    created_at: "2030-01-01T00:00:00Z",
    updated_at: "2030-01-02T00:00:00Z",
  },
];
export const goldenResults: GoldenResult[] = [
  {
    id: "public-result-a",
    prompt_id: "public-prompt-a",
    model: "public-model-a",
    score: 0.5,
    passed: false,
    cost_krw: 2.5,
    latency_ms: 1600,
    response: "공개 검사 응답",
    created_at: "2030-01-03T00:00:00Z",
  },
  {
    id: "public-result-b",
    prompt_id: "public-prompt-b",
    model: "public-model-b",
    score: 0,
    passed: true,
    cost_krw: 0,
    latency_ms: 0,
    response: "기대 내용 없이 통과한 공개 응답",
    created_at: "2030-01-02T00:00:00Z",
  },
];
export const goldenWorkflows: GoldenWorkflow[] = [
  {
    id: "public-workflow-a",
    name: "모델 교체 검증",
    description: "순서가 있는 독립 검사",
    tags: ["배포"],
    created_at: "2030-01-01T00:00:00Z",
    updated_at: "2030-01-02T00:00:00Z",
    steps: [
      {
        name: "첫 번째 검사",
        prompt: "첫 질문",
        expected: "첫 답변",
        selected_model: "public-model-a",
        baseline_score: 82.5,
        task_type: "한글",
        contract_id: "public-contract",
        rubric_id: "public-rubric",
        source_run_id: "public-source",
      },
      { name: "두 번째 검사", prompt: "두 번째 질문", expected: "두 번째 답변" },
    ],
  },
  {
    id: "public-workflow-unknown",
    name: "확인이 필요한 세트",
    description: "",
    tags: null,
    steps: null,
    created_at: "2030-01-01T00:00:00Z",
    updated_at: "2030-01-02T00:00:00Z",
  },
];
