import { expect, it } from "vitest";
import { workflowFormSchema } from "./workflow-form";
it("지원하지 않는 단계 필드를 조용히 제거하지 않고 저장을 거부한다", () => {
  const values = {
    name: "순차 정의",
    description: "",
    allowed_teams: "",
    enabled: false,
    steps: JSON.stringify([{ name: "전달", type: "transform", retry_policy: { count: 3 } }]),
  };
  expect(workflowFormSchema.safeParse(values).success).toBe(false);
  values.steps = JSON.stringify([
    { name: "전달", type: "transform", note: "기존 메모", allowed_tools: ["public_tool"] },
  ]);
  expect(workflowFormSchema.parse(values).steps[0]).toMatchObject({
    note: "기존 메모",
    allowed_tools: ["public_tool"],
  });
});
