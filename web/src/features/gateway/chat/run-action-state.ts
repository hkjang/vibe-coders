import { z } from "zod";

export type RunActionKind = "feedback" | "promote" | "golden";
export interface RunActionSnapshot {
  readonly kind: RunActionKind;
  readonly runId: string;
  readonly models: readonly string[];
  readonly prompt: string;
}

export const ratings = ["5", "4", "3", "2", "1", "0"] as const;
export const runActionLabels = {
  feedback: {
    trigger: "평가 남기기",
    title: "모델 평가 남기기",
    submit: "저장",
    description: "사람이 매긴 평점은 리더보드와 학습 신호로 쓰입니다.",
    success: "평가를 기록했습니다.",
  },
  promote: {
    trigger: "라우팅 후보로 승격",
    title: "라우팅 후보로 승격",
    submit: "초안으로 저장",
    description:
      "선택한 모델을 라우팅 규칙 초안으로 저장합니다. 사람이 검토하기 전에는 라우팅에 적용되지 않습니다.",
    success: "라우팅 후보(초안)로 저장했습니다. 검토 전에는 라우팅에 적용되지 않습니다.",
  },
  golden: {
    trigger: "골든 답변으로 저장",
    title: "골든 답변으로 저장",
    submit: "저장",
    description:
      "선택한 모델의 결과와 이 실행의 질문을 골든 워크플로 단계로 저장해 모델 교체 회귀 검사에 씁니다.",
    success: "골든 워크플로 단계로 저장했습니다.",
  },
} as const;

// Model choices are captured identifiers, not free-text identifiers to normalize.
// Membership is checked again at submission.
const fields = z.object({
  model: z.string().min(1, "모델을 선택하세요."),
  rating: z.enum(ratings),
  label: z.string().trim().max(120),
  comment: z.string().trim().max(2000),
  task_type: z.string().trim().max(120),
  reason: z.string().trim().max(1000),
  workflow_id: z.string().trim().max(120),
  workflow_name: z.string().trim().max(200),
  step_name: z.string().trim().max(200),
  expected: z.string().trim().max(2000),
});
export type RunActionValues = z.output<typeof fields>;

export function runActionSchema(kind: RunActionKind) {
  return fields.superRefine((values, context) => {
    if (kind === "promote" && !values.reason)
      context.addIssue({ code: "custom", path: ["reason"], message: "승격 사유를 입력하세요." });
    if (kind === "golden" && !values.workflow_id && !values.workflow_name)
      context.addIssue({
        code: "custom",
        path: ["workflow_name"],
        message: "워크플로 이름 또는 기존 워크플로 ID 중 하나는 있어야 합니다.",
      });
  });
}

export function runActionDefaults(snapshot: RunActionSnapshot): RunActionValues {
  return {
    model: snapshot.models[0] ?? "",
    rating: "4",
    label: "",
    comment: "",
    task_type: "",
    reason: "",
    workflow_id: "",
    workflow_name: "",
    step_name: "",
    expected: "",
  };
}
