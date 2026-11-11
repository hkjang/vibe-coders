import { expect, it, vi } from "vitest";
import { AppError } from "@/shared/api/error";
import { mockApi, apiFailure } from "@/test/api";
import { goldenPrompts, goldenWorkflows } from "../../../../../tests/fixtures/golden-regression";
import {
  definitionDefaults,
  definitionSchema,
  definitionSignature,
  editableDefinition,
  newDefinitionTarget,
  promptBody,
  workflowBody,
  type DefinitionTarget,
} from "./definition-form";
import { confirmDefinition, safeDefinitionError, saveDefinition } from "./definition-write";
import { hiddenText } from "../regression-model";

const firstPrompt = goldenPrompts[0];
if (!firstPrompt) throw new Error("public prompt fixture missing");
const firstWorkflow = goldenWorkflows[0];
if (!firstWorkflow) throw new Error("public workflow fixture missing");
const prompt: DefinitionTarget = { kind: "prompt", id: firstPrompt.id, original: firstPrompt };
const workflow: DefinitionTarget = {
  kind: "workflow",
  id: firstWorkflow.id,
  original: firstWorkflow,
};
const draft = () =>
  definitionSchema.parse({
    ...definitionDefaults(prompt),
    name: " 새 이름 ",
    expected: " 기대 ",
    tags: '["a,b"," spaced ","line\\nbreak"]',
  });
it("보안 컨텍스트 전용 randomUUID 없이도 고정된 새 항목 식별자를 생성한다", () => {
  const uuid = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    throw new Error("unavailable on HTTP");
  });
  const prompt = newDefinitionTarget("prompt"),
    workflow = newDefinitionTarget("workflow");
  expect(prompt.id).toMatch(/^golden_ui_[a-f0-9]{32}$/);
  expect(workflow.id).toMatch(/^gwf_ui_[a-f0-9]{32}$/);
  expect(uuid).not.toHaveBeenCalled();
});
it("정의 필드만 전송하고 기대 내용·태그의 공백과 쉼표를 보존한다", async () => {
  const values = draft();
  const body = promptBody(prompt.id, values);
  const api = mockApi({
    "GET /admin/golden-prompts": () => ({ golden_prompts: goldenPrompts, results: [] }),
    "POST /admin/golden-prompts": () => ({ golden_prompt: { ...firstPrompt, ...body }, results: [] }),
  });
  const guard = vi.fn();
  await saveDefinition(prompt, values, guard);
  expect(api.bodies("POST /admin/golden-prompts")).toEqual([
    {
      id: prompt.id,
      name: "새 이름",
      prompt: firstPrompt.prompt,
      expected: " 기대 ",
      tags: ["a,b", " spaced ", "line\nbreak"],
    },
  ]);
  expect(api.spy.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store", retryUnauthorized: false });
  expect(api.spy.mock.calls.at(-1)?.[1]).toMatchObject({
    retryUnauthorized: false,
    routeId: "prompts.regression",
  });
  expect(guard).toHaveBeenCalledTimes(4);
});
it("단계 재배치 시 점수와 출처가 함께 이동하며 실행·시간 필드를 보내지 않는다", async () => {
  const values = definitionSchema.parse(definitionDefaults(workflow));
  values.steps.reverse();
  const body = workflowBody(workflow.id, values);
  const api = mockApi({
    "GET /admin/golden-workflows": () => ({ workflows: goldenWorkflows }),
    "POST /admin/golden-workflows": () => ({
      ...firstWorkflow,
      ...body,
      steps: body.steps.map((step) =>
        Object.fromEntries(Object.entries(step).filter(([, value]) => value !== "" && value !== 0)),
      ),
    }),
  });
  await saveDefinition(workflow, values, () => {});
  expect(api.bodies("POST /admin/golden-workflows")[0]).toMatchObject({
    steps: [
      { prompt: "두 번째 질문" },
      {
        baseline_score: 82.5,
        source_run_id: "public-source",
        contract_id: "public-contract",
        selected_model: "public-model-a",
      },
    ],
  });
  expect(Object.keys(body).sort()).toEqual(["description", "id", "name", "steps", "tags"]);
});
it.each(["changed", "removed", "timestamp"])("최신 정의 %s 변경이면 POST를 보내지 않는다", async (kind) => {
  const latest =
    kind === "removed"
      ? []
      : [
          {
            ...firstPrompt,
            ...(kind === "changed" ? { prompt: "다른 입력" } : { updated_at: "2031-01-01T00:00:00Z" }),
          },
        ];
  const api = mockApi({ "GET /admin/golden-prompts": () => ({ golden_prompts: latest, results: [] }) });
  await expect(saveDefinition(prompt, draft(), () => {})).rejects.toMatchObject({ code: "golden_changed" });
  expect(api.calls).toHaveLength(1);
});
it("신규 식별자가 이미 있으면 덮어쓰지 않는다", async () => {
  const api = mockApi({
    "GET /admin/golden-prompts": () => ({ golden_prompts: goldenPrompts, results: [] }),
  });
  await expect(saveDefinition({ kind: "prompt", id: prompt.id }, draft(), () => {})).rejects.toMatchObject({
    code: "golden_changed",
  });
  expect(api.calls).toHaveLength(1);
});
it("사전 조회 실패와 조회 중 권한 상실은 쓰기 없이 종료한다", async () => {
  const api = mockApi({
    "GET /admin/golden-prompts": () => {
      throw apiFailure("private detail");
    },
  });
  await expect(saveDefinition(prompt, draft(), () => {})).rejects.toMatchObject({ status: 500 });
  expect(api.calls).toHaveLength(1);
  api.spy.mockRestore();
  const second = mockApi({
    "GET /admin/golden-prompts": () => ({ golden_prompts: goldenPrompts, results: [] }),
  });
  let checks = 0;
  await expect(
    saveDefinition(prompt, draft(), () => {
      if (++checks > 1) throw apiFailure("denied", 403);
    }),
  ).rejects.toMatchObject({ status: 403 });
  expect(second.calls).toHaveLength(1);
});
it.each(["network", "wrong_id", "unexpected_execution", "server"])(
  "전송 후 %s이면 결과 미확인으로 분류하고 재전송하지 않는다",
  async (kind) => {
    const api = mockApi({
      "GET /admin/golden-prompts": () => ({ golden_prompts: goldenPrompts, results: [] }),
      "POST /admin/golden-prompts": () => {
        if (kind === "network") throw new AppError("private", { kind: "network" });
        if (kind === "server") throw apiFailure("private");
        return {
          golden_prompt: {
            ...firstPrompt,
            ...promptBody(prompt.id, draft()),
            ...(kind === "wrong_id" ? { id: "other" } : {}),
          },
          results: kind === "unexpected_execution" ? [{}] : [],
        };
      },
    });
    await expect(saveDefinition(prompt, draft(), () => {})).rejects.toMatchObject({ code: "golden_unknown" });
    expect(api.bodies("POST /admin/golden-prompts")).toHaveLength(1);
  },
);
it("명시적 인증 거부는 재시도 없이 전달한다", async () => {
  const api = mockApi({
    "GET /admin/golden-prompts": () => ({ golden_prompts: goldenPrompts, results: [] }),
    "POST /admin/golden-prompts": () => {
      throw apiFailure("private", 401);
    },
  });
  await expect(saveDefinition(prompt, draft(), () => {})).rejects.toMatchObject({ status: 401 });
  expect(api.bodies("POST /admin/golden-prompts")).toHaveLength(1);
});
it("미확인 저장 상태는 GET만으로 비교하며 다르거나 없으면 완료로 표시하지 않는다", async () => {
  let matched = true;
  const api = mockApi({
    "GET /admin/golden-prompts": () => ({
      golden_prompts: matched ? [{ ...firstPrompt, ...promptBody(prompt.id, draft()) }] : [],
      results: [],
    }),
  });
  await confirmDefinition(prompt, draft(), () => {});
  matched = false;
  await expect(confirmDefinition(prompt, draft(), () => {})).rejects.toMatchObject({
    code: "golden_unmatched",
  });
  expect(api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
});
it("숨김값과 알 수 없는 단계는 편집 불가이며 빈 정의를 몰래 복구하지 않는다", () => {
  expect(
    editableDefinition(
      { kind: "prompt", id: prompt.id, original: { ...firstPrompt, prompt: hiddenText } },
      [],
    ),
  ).toBe(false);
  expect(editableDefinition({ kind: "workflow", id: "unknown", original: goldenWorkflows[1] }, [])).toBe(
    false,
  );
  expect(
    editableDefinition(
      {
        kind: "workflow",
        id: workflow.id,
        original: { ...firstWorkflow, description: "corp_" + "x".repeat(40) },
      },
      ["corp_"],
    ),
  ).toBe(false);
  expect(definitionSignature({ kind: "prompt", id: "new" })).toBeUndefined();
});
it("빈 이름·입력·잘못된 태그를 필드별 오류로 검증한다", () => {
  const result = definitionSchema.safeParse({
    ...definitionDefaults(prompt),
    name: " ",
    prompt: " ",
    tags: "{}",
  });
  expect(result.success).toBe(false);
  if (!result.success)
    expect(result.error.issues.map((issue) => issue.path[0])).toEqual(
      expect.arrayContaining(["name", "tags"]),
    );
  const stepResult = definitionSchema.safeParse({
    ...definitionDefaults(workflow),
    steps: [{ name: "", prompt: " ", expected: "" }],
  });
  expect(stepResult.success).toBe(false);
});
it("오류 캐시에 원문 응답·비밀값 요청 ID를 남기지 않는다", () => {
  const safe = safeDefinitionError(
    new AppError("private", {
      kind: "contract",
      requestId: "corp_" + "x".repeat(40),
      details: "private body",
      cause: "private",
    }),
    ["corp_"],
  );
  expect(safe.message).not.toContain("private");
  expect(safe.details).toBeUndefined();
  expect(safe.requestId).toBeUndefined();
});
