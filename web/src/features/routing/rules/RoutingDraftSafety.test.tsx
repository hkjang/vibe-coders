import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import { changeModel, deferred, openEdit, patchPath, setupEdit } from "./routing-edit-test-harness";

const plan = {
  requested_model: "public-request",
  selected_model: "public-model-a",
  selected_provider: "public-provider",
  policy_api_key_id: "",
  complexity: { score: 12, tier: "simple" },
  risk: { score: 0, tier: "low", categories: [] },
  health_score: 100,
  fallback_plan: ["no_provider_failover:single_matching_provider"],
  route_reason: "complexity_rule",
  decision_reason: "public selection",
  would_rewrite: true,
};
const comparison = {
  stage: "routing_plan",
  revision: "a".repeat(64),
  runtime_consistency: "sequential_live_reads",
  observed_at: "2026-11-17T00:00:00Z",
  before: plan,
  after: { ...plan, selected_model: "public-model-b" },
};

async function prepare() {
  const current = await setupEdit({}, true);
  current.response.preview = () => comparison;
  const { dialog } = await openEdit(current);
  await changeModel(current, dialog);
  await current.user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
  await current.user.type(within(dialog).getByLabelText("시험 모델", { exact: false }), "public-request");
  await current.user.type(within(dialog).getByLabelText("예시 요청", { exact: false }), "공개 예시 질문");
  await current.user.type(
    within(dialog).getByLabelText("변경 사유", { exact: false }),
    "공개 운영 변경 사유",
  );
  return { ...current, dialog };
}

describe("라우팅 초안 비교와 검토 기준 저장", () => {
  it("새 비교 계약의 모델 길이를 편집 필드에서 확인한다", async () => {
    const current = await setupEdit({}, true);
    const { dialog } = await openEdit(current);
    const target = within(dialog).getByRole("textbox", { name: "대상 모델" });
    await current.user.clear(target);
    await current.user.type(target, "m".repeat(257));
    await current.user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
    expect(target).toHaveFocus();
    expect(within(dialog).getByText("대상 모델은 256자 이하로 입력하세요.")).toBeVisible();
    expect(current.count(patchPath)).toBe(0);
  });
  it("필수 시험 입력이 없으면 첫 오류 입력으로 초점을 옮기고 전송하지 않는다", async () => {
    const current = await setupEdit({}, true);
    const { dialog } = await openEdit(current);
    await changeModel(current, dialog);
    await current.user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
    await current.user.click(within(dialog).getByRole("button", { name: "초안 결과 비교" }));
    expect(within(dialog).getByLabelText("시험 모델", { exact: false })).toHaveFocus();
    expect(within(dialog).getByText("시험 모델 항목을 입력하세요.")).toBeVisible();
    expect(current.count("POST /admin/routing/preview")).toBe(0);
  });
  it("조회 중 쓰기 권한이 사라지면 늦은 결과로 저장을 허용하지 않는다", async () => {
    const current = await prepare();
    const held = deferred<unknown>();
    current.response.preview = () => held.promise;
    await current.user.click(within(current.dialog).getByRole("button", { name: "초안 결과 비교" }));
    await waitFor(() => expect(current.count("POST /admin/routing/preview")).toBe(1));
    current.update({ scopes: ["routing:read"] });
    await act(async () => held.resolve(comparison));
    expect(screen.queryByRole("heading", { name: "실행 계획 비교 결과" })).not.toBeInTheDocument();
    expect(current.count(patchPath)).toBe(0);
  });
  it("비교 전에는 저장하지 않고 같은 검토 기준·사유·부분 변경을 한 번 전송한다", async () => {
    const current = await prepare();
    await current.user.click(within(current.dialog).getByRole("button", { name: "규칙 저장" }));
    expect(current.count(patchPath)).toBe(0);
    await current.user.click(within(current.dialog).getByRole("button", { name: "초안 결과 비교" }));
    await screen.findByRole("heading", { name: "실행 계획 비교 결과" });
    expect(current.dialog).toHaveTextContent("public-model-b (변경)");
    expect(current.dialog).toHaveTextContent("대체할 공급자 없음");
    await current.user.click(within(current.dialog).getByRole("button", { name: "규칙 저장" }));
    await waitFor(() => expect(current.count(patchPath)).toBe(1));
    expect(current.calls.find((call) => call.key === patchPath)).toMatchObject({
      query: { review: "edit" },
      body: {
        expected_revision: "a".repeat(64),
        reason: "공개 운영 변경 사유",
        patch: { target_model: "public-model-b" },
      },
    });
    expect(await screen.findByText("라우팅 규칙을 저장했습니다.")).toBeVisible();
  });
  it("시험 입력을 바꾸면 이전 결과와 저장 자격을 없앤다", async () => {
    const current = await prepare();
    await current.user.click(within(current.dialog).getByRole("button", { name: "초안 결과 비교" }));
    await screen.findByRole("heading", { name: "실행 계획 비교 결과" });
    await current.user.type(within(current.dialog).getByLabelText("예시 요청", { exact: false }), " 변경");
    expect(screen.queryByRole("heading", { name: "실행 계획 비교 결과" })).not.toBeInTheDocument();
    await current.user.click(within(current.dialog).getByRole("button", { name: "규칙 저장" }));
    expect(current.count(patchPath)).toBe(0);
  });
  it("비교를 취소하면 늦은 응답이 저장을 다시 허용하지 않는다", async () => {
    const current = await prepare();
    const held = deferred<unknown>();
    current.response.preview = () => held.promise;
    await current.user.click(within(current.dialog).getByRole("button", { name: "초안 결과 비교" }));
    await waitFor(() => expect(current.count("POST /admin/routing/preview")).toBe(1));
    await current.user.click(within(current.dialog).getByRole("button", { name: "비교 취소" }));
    await act(async () => held.resolve(comparison));
    expect(screen.queryByRole("heading", { name: "실행 계획 비교 결과" })).not.toBeInTheDocument();
    await current.user.click(within(current.dialog).getByRole("button", { name: "규칙 저장" }));
    expect(current.count(patchPath)).toBe(0);
  });
  it("검토 기준이 다른 응답과 서버 충돌은 저장 가능한 비교로 표시하지 않는다", async () => {
    const current = await prepare();
    current.response.preview = () => ({ ...comparison, revision: "c".repeat(64) });
    await current.user.click(within(current.dialog).getByRole("button", { name: "초안 결과 비교" }));
    await screen.findByText("초안 결과를 확인하지 못했습니다.");
    expect(screen.queryByRole("heading", { name: "실행 계획 비교 결과" })).not.toBeInTheDocument();
    current.response.preview = () => {
      throw new AppError("기준 변경", { kind: "http", status: 409, code: "routing_draft_conflict" });
    };
    await current.user.click(within(current.dialog).getByRole("button", { name: "초안 결과 비교" }));
    await waitFor(() => expect(current.count("POST /admin/routing/preview")).toBe(2));
    expect(current.count(patchPath)).toBe(0);
  });
});
