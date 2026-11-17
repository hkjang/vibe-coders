import { createRef } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import axe from "axe-core";
import { RedTeamReviewedReplay } from "./RedTeamReviewedReplay";
import { replayReviewFixture, replayOutcomeFixture } from "./reviewed-replay-fixture";
import { replayReviewSchema, replayOutcomeSchema } from "@/shared/api/domains/redteam-replay";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi } from "@/test/api";

const prepare = "POST /admin/redteam/results/public-source-result/rerun-review";
const execute = "POST /admin/redteam/results/public-source-result/rerun-reviewed";
function mount(key = "public-execution-key", canWrite = true) {
  const onResult = vi.fn(),
    onClose = vi.fn(),
    onOpenRun = vi.fn();
  const ui = (proxyKey = key, write = canWrite, resultId = "public-source-result") => (
    <FeatureAccessContext.Provider
      value={{ featureId: "security.redteam", permitted: true, readOnly: !write }}
    >
      <RedTeamReviewedReplay
        resultId={resultId}
        model="public-model"
        proxyKey={proxyKey}
        canWrite={write}
        onClose={onClose}
        onResult={onResult}
        onOpenRun={onOpenRun}
        returnFocusRef={createRef<HTMLElement>()}
      />
    </FeatureAccessContext.Provider>
  );
  return { ...render(ui()), ui, onResult, onClose, onOpenRun };
}
async function review() {
  await userEvent.type(screen.getByLabelText("재실행 사유", { exact: false }), "공개 실행 점검");
  await userEvent.click(screen.getByRole("button", { name: "재실행 조건 검토" }));
  return screen.findByRole("dialog", { name: "한 건 재실행 최종 확인" });
}
async function confirm() {
  await userEvent.type(screen.getByLabelText("원본 결과 ID 확인", { exact: false }), "public-source-result");
  await userEvent.click(screen.getByRole("button", { name: "검토한 한 건만 실제 재실행" }));
}

it("마스킹 기본값과 원본 보존을 설명하고 재입력 뒤 한 번만 실행한다", async () => {
  const record = replayReviewFixture();
  const api = mockApi({ [prepare]: () => record, [execute]: () => replayOutcomeFixture(record) });
  const view = mount();
  expect(screen.getByRole("checkbox", { name: "새 증적에 입력·응답 원문 보관" })).not.toBeChecked();
  const panel = await review();
  expect(api.bodies(execute)).toEqual([]);
  expect(view.onClose).not.toHaveBeenCalled();
  expect(api.bodies(prepare)).toEqual([
    {
      reason: "공개 실행 점검",
      model: "public-model",
      limits: { max_calls: 1, max_output_tokens: 512, budget_limit_krw: 10 },
      retain_raw_evidence: false,
    },
  ]);
  expect(within(panel).getByText(/캠페인 상태나 검사 묶음의 통과 기준선/)).toBeVisible();
  expect((await axe.run(panel)).violations).toEqual([]);
  await confirm();
  await waitFor(() => expect(view.onResult).toHaveBeenCalledOnce());
  expect(api.bodies(execute)).toEqual([
    { review_token: record.review_token, proxy_key: "public-execution-key" },
  ]);
  expect(api.bodies("POST /admin/redteam/results/public-source-result/rerun")).toEqual([]);
  await userEvent.click(screen.getByRole("button", { name: "새 실행 결과 보기" }));
  expect(view.onOpenRun).toHaveBeenCalledWith("public-run");
});

it.each([401, 409, 500, 503])("%s 미확정 결과를 자동 재전송하지 않고 요청 ID를 보여준다", async (status) => {
  const api = mockApi({
    [prepare]: () => replayReviewFixture(),
    [execute]: () => {
      throw apiFailure("private upstream payload", status);
    },
  });
  mount();
  await review();
  await confirm();
  expect(await screen.findByText(/재실행 결과를 확정할 수 없습니다/)).toBeVisible();
  expect(screen.queryByText("private upstream payload")).toBeNull();
  expect(screen.getByText("요청 ID: req_test")).toBeVisible();
  expect(screen.getByRole("button", { name: "검토한 한 건만 실제 재실행" })).toBeDisabled();
  expect(api.bodies(execute)).toHaveLength(1);
});

it("검토 중 원문 보관을 명시 선택하고 일치하지 않는 응답은 거부한다", async () => {
  const api = mockApi({ [prepare]: () => replayReviewFixture() });
  mount();
  await userEvent.click(screen.getByRole("checkbox", { name: "새 증적에 입력·응답 원문 보관" }));
  await userEvent.type(screen.getByLabelText("재실행 사유", { exact: false }), "공개 실행 점검");
  await userEvent.click(screen.getByRole("button", { name: "재실행 조건 검토" }));
  await waitFor(() => expect(api.bodies(prepare)).toHaveLength(1));
  expect(api.bodies(prepare)[0]).toMatchObject({ retain_raw_evidence: true });
  expect(screen.queryByRole("dialog", { name: "한 건 재실행 최종 확인" })).toBeNull();
  expect(api.bodies(execute)).toEqual([]);
});

it.each(["key", "permission", "source"])("%s가 바뀌면 이전 검토로 실행하지 않는다", async (field) => {
  const api = mockApi({ [prepare]: () => replayReviewFixture() });
  const view = mount();
  await review();
  view.rerender(
    view.ui(
      field === "key" ? "changed-key" : "public-execution-key",
      field !== "permission",
      field === "source" ? "other-result" : "public-source-result",
    ),
  );
  if (field === "permission")
    expect(screen.getByRole("button", { name: "검토한 한 건만 실제 재실행" })).toBeDisabled();
  else await waitFor(() => expect(view.onClose).toHaveBeenCalled());
  expect(api.bodies(execute)).toEqual([]);
});

it("중복 클릭과 닫힌 화면의 늦은 실행 응답을 무시한다", async () => {
  let finish: ((value: unknown) => void) | undefined;
  const api = mockApi({
    [prepare]: () => replayReviewFixture(),
    [execute]: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const view = mount();
  await review();
  await userEvent.type(screen.getByLabelText("원본 결과 ID 확인", { exact: false }), "public-source-result");
  const button = screen.getByRole("button", { name: "검토한 한 건만 실제 재실행" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(api.bodies(execute)).toHaveLength(1);
  view.unmount();
  await act(async () => finish?.(replayOutcomeFixture()));
  expect(view.onResult).not.toHaveBeenCalled();
});

it("실행 키가 없으면 검토 요청도 보내지 않는다", async () => {
  const api = mockApi({});
  mount("");
  await userEvent.type(screen.getByLabelText("재실행 사유", { exact: false }), "공개 실행 점검");
  await userEvent.click(screen.getByRole("button", { name: "재실행 조건 검토" }));
  expect(await screen.findByText("화면 상단에 전용 실행 키를 입력하세요.")).toBeVisible();
  expect(api.bodies(prepare)).toEqual([]);
});

it("원본 ID가 다른 응답과 여러 건의 재실행 계약을 거부한다", () => {
  const review = replayReviewFixture();
  expect(replayReviewSchema.safeParse({ ...review, case_executions: 2 }).success).toBe(false);
  const result = replayOutcomeFixture(review);
  expect(replayOutcomeSchema.safeParse({ ...result, source_result_id: "other" }).success).toBe(false);
  expect(
    replayOutcomeSchema.safeParse({ ...result, runs: [{ ...result.runs[0], id: result.source_run_id }] })
      .success,
  ).toBe(false);
});
