import { createRef } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { RedTeamReviewedExecution } from "./RedTeamReviewedExecution";
import { executionReviewFixture, executionOutcomeFixture } from "./reviewed-execution-fixture";
import { executionJobFixture, executionJobId } from "./job-fixture";
import { redTeamCampaignSchema } from "@/shared/api/domains/redteam";
import { redTeamReviewSchema, reviewedOutcomeSchema } from "@/shared/api/domains/redteam-reviewed";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi } from "@/test/api";
const prepare = "POST /admin/redteam/campaigns/public-campaign/run-review",
  execute = "POST /admin/redteam/campaigns/public-campaign/run-reviewed";
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth() };
});
const campaign = redTeamCampaignSchema.parse({
  id: "public-campaign",
  name: "공개 실행",
  execution_mode: "active-controlled",
});
function mount(
  onResult = vi.fn(),
  proxyKey = "public-synthetic-key",
  canWrite = true,
  history = false,
  jobs = false,
) {
  const onClose = vi.fn();
  const onOpenHistory = vi.fn();
  const onJobTracked = vi.fn();
  const onJobAccepted = vi.fn();
  const props = {
    campaign,
    proxyKey,
    canWrite,
    onResult,
    onClose,
    onPending: vi.fn(),
    onOpenHistory,
    onJobTracked: jobs ? onJobTracked : undefined,
    onJobAccepted: jobs ? onJobAccepted : undefined,
    historyAvailable: () => history,
    returnFocusRef: createRef<HTMLElement>(),
  };
  const ui = (key = proxyKey, write = canWrite) => (
    <FeatureAccessContext.Provider
      value={{ featureId: "security.redteam", permitted: true, readOnly: !write }}
    >
      <RedTeamReviewedExecution {...props} proxyKey={key} canWrite={write} />
    </FeatureAccessContext.Provider>
  );
  return { ...render(ui()), onResult, onClose, onOpenHistory, onJobTracked, onJobAccepted, ui };
}
async function review() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("실행 사유", { exact: false }), "공개 실행 점검");
  await user.click(screen.getByRole("button", { name: "실행 조건 검토" }));
  return await screen.findByRole("dialog", { name: "실행 조건 최종 확인" });
}
async function confirm() {
  await userEvent.type(screen.getByLabelText("캠페인 이름 확인", { exact: false }), "공개 실행");
  await userEvent.click(screen.getByRole("button", { name: "검토한 조건으로 한 번 실행" }));
}
describe("검토한 레드팀 실행", () => {
  it("작업 지원 서버에는 접수 요청을 한 번 보내고 결과 대기 없이 상태 주소를 전달한다", async () => {
    const record = executionReviewFixture({ job_id: executionJobId });
    let trackedBeforePost = false;
    const api = mockApi({
      [prepare]: () => record,
      [execute]: () => {
        trackedBeforePost = view.onJobTracked.mock.calls.length === 1;
        return executionJobFixture();
      },
    });
    const view = mount(vi.fn(), "public-synthetic-key", true, false, true);
    await review();
    await confirm();
    await waitFor(() =>
      expect(view.onJobAccepted).toHaveBeenCalledWith({ id: executionJobId, campaign: "public-campaign" }),
    );
    expect(trackedBeforePost).toBe(true);
    expect(view.onResult).not.toHaveBeenCalled();
    expect(api.calls.filter((call) => call.key === execute)).toEqual([
      {
        key: execute,
        options: {
          query: { job: "1" },
          body: { review_token: record.review_token, proxy_key: "public-synthetic-key" },
        },
      },
    ]);
  });
  it("작업 접수 응답 유실은 주소를 유지하며 동기 실행이나 같은 요청으로 재시도하지 않는다", async () => {
    const api = mockApi({
      [prepare]: () => executionReviewFixture({ job_id: executionJobId }),
      [execute]: () => {
        throw apiFailure("lost", 503);
      },
    });
    const view = mount(vi.fn(), "public-synthetic-key", true, false, true);
    await review();
    await confirm();
    await screen.findByText(/실행 결과를 확정할 수 없습니다/u);
    expect(view.onJobTracked).toHaveBeenCalledWith({ id: executionJobId, campaign: "public-campaign" });
    expect(view.onJobAccepted).not.toHaveBeenCalled();
    expect(api.bodies(execute)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "검토한 조건으로 한 번 실행" })).toBeDisabled();
  });
  it("작업 상태를 추적할 화면이 없으면 실행을 보내지 않는다", async () => {
    const api = mockApi({ [prepare]: () => executionReviewFixture({ job_id: executionJobId }) });
    mount();
    await review();
    await confirm();
    expect(api.bodies(execute)).toHaveLength(0);
  });
  it("실행 중 이력 이동은 다시 실행하지 않고 늦은 결과로 화면을 바꾸지 않는다", async () => {
    let finish: ((value: unknown) => void) | undefined;
    const record = executionReviewFixture();
    const api = mockApi({
      [prepare]: () => record,
      [execute]: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const view = mount(vi.fn(), "public-synthetic-key", true, true);
    await review();
    expect(screen.queryByRole("button", { name: "이 검토의 실행 이력" })).toBeNull();
    await confirm();
    await userEvent.click(await screen.findByRole("button", { name: "이 검토의 실행 이력" }));
    expect(view.onOpenHistory).toHaveBeenCalledWith(record.review_id);
    expect(view.onClose).toHaveBeenCalledOnce();
    await act(async () => {
      finish?.(executionOutcomeFixture(record));
    });
    expect(view.onResult).not.toHaveBeenCalled();
    expect(api.bodies(execute)).toHaveLength(1);
  });
  it("응답 오류 후 해당 검토 이력으로 이동할 수 있다", async () => {
    const api = mockApi({
      [prepare]: () => executionReviewFixture(),
      [execute]: () => {
        throw apiFailure("private", 503);
      },
    });
    const view = mount(vi.fn(), "public-synthetic-key", true, true);
    await review();
    await confirm();
    await screen.findByText(/실행 결과를 확정할 수 없습니다/);
    await userEvent.click(screen.getByRole("button", { name: "이 검토의 실행 이력" }));
    expect(view.onOpenHistory).toHaveBeenCalledWith("public-review");
    expect(api.bodies(execute)).toHaveLength(1);
  });
  it("이전 서버에서는 지원하지 않는 이력 링크를 표시하지 않는다", async () => {
    mockApi({
      [prepare]: () => executionReviewFixture(),
      [execute]: () => {
        throw apiFailure("private", 503);
      },
    });
    mount();
    await review();
    await confirm();
    await screen.findByText(/실행 결과를 확정할 수 없습니다/);
    expect(screen.queryByRole("button", { name: "이 검토의 실행 이력" })).toBeNull();
  });
  it("다른 검토에 속한 실행 영수증을 거부하고 이전 서버의 생략은 허용한다", () => {
    const outcome = executionOutcomeFixture();
    expect(reviewedOutcomeSchema.safeParse(outcome).success).toBe(true);
    const run = outcome.runs[0];
    if (!run) throw Error("missing run");
    run.review_id = "another-review";
    expect(reviewedOutcomeSchema.safeParse(outcome).success).toBe(false);
    run.review_id = outcome.review_id;
    expect(reviewedOutcomeSchema.safeParse(outcome).success).toBe(true);
  });
  it("검토와 실행을 구분하고 한글 대상·한도를 보여준다", async () => {
    const record = executionReviewFixture(),
      api = mockApi({ [prepare]: () => record, [execute]: () => executionOutcomeFixture(record) }),
      view = mount();
    expect(screen.getByText(/Text2SQL·MCP·앱·워크플로 대상은 시뮬레이션으로/)).toBeVisible();
    const panel = await review();
    expect(within(panel).getByText(/다단계 가상 모델은 실제 호출에서 제외/)).toBeVisible();
    expect(api.bodies(execute)).toEqual([]);
    expect(within(panel).getByText("호출당 출력 토큰 요청 상한")).toBeVisible();
    expect(within(panel).getByText("public-model")).toBeVisible();
    expect(within(panel).getByRole("button", { name: "검토한 조건으로 한 번 실행" })).toBeDisabled();
    expect((await axe.run(panel)).violations).toEqual([]);
    await confirm();
    await waitFor(() => expect(view.onResult).toHaveBeenCalledOnce());
    expect(api.bodies(execute)).toEqual([
      { review_token: record.review_token, proxy_key: "public-synthetic-key" },
    ]);
    const options = api.spy.mock.calls.find(([endpoint]) => endpoint.path.endsWith("run-reviewed"))?.[1];
    expect(options).toMatchObject({ retryUnauthorized: false, timeoutMs: 130000 });
  });
  it.each([401, 409, 500, 503])(
    "실행의 %s 응답은 자동 재시도하지 않고 결과 확인을 안내한다",
    async (status) => {
      const api = mockApi({
        [prepare]: () => executionReviewFixture(),
        [execute]: () => {
          throw apiFailure("private upstream text", status);
        },
      });
      mount();
      await review();
      await confirm();
      expect(await screen.findByText(/실행 결과를 확정할 수 없습니다/)).toBeVisible();
      expect(screen.queryByText("private upstream text")).toBeNull();
      expect(screen.getByText("요청 ID: req_test")).toBeVisible();
      expect(screen.getByRole("button", { name: "검토한 조건으로 한 번 실행" })).toBeDisabled();
      expect(api.bodies(execute)).toHaveLength(1);
    },
  );
  it("중복 클릭으로 같은 검토를 다시 보내지 않는다", async () => {
    let finish: ((value: unknown) => void) | undefined;
    const api = mockApi({
      [prepare]: () => executionReviewFixture(),
      [execute]: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const view = mount();
    await review();
    await userEvent.type(screen.getByLabelText("캠페인 이름 확인", { exact: false }), "공개 실행");
    const button = screen.getByRole("button", { name: "검토한 조건으로 한 번 실행" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.bodies(execute)).toHaveLength(1);
    view.unmount();
    await act(async () => finish?.(executionOutcomeFixture()));
    expect(view.onResult).not.toHaveBeenCalled();
  });
  it("권한을 잃으면 실행할 수 없다", async () => {
    const api = mockApi({ [prepare]: () => executionReviewFixture() });
    const view = mount();
    await review();
    view.rerender(view.ui("public-synthetic-key", false));
    expect(screen.getByRole("button", { name: "검토한 조건으로 한 번 실행" })).toBeDisabled();
    expect(api.bodies(execute)).toEqual([]);
  });
  it("실행 키가 바뀌면 이전 검토를 폐기한다", async () => {
    const api = mockApi({ [prepare]: () => executionReviewFixture() });
    const view = mount();
    await review();
    view.rerender(view.ui("changed-public-key"));
    await waitFor(() => expect(view.onClose).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.bodies(execute)).toEqual([]);
  });
  it("이전 세션의 늦은 검토 응답을 표시하지 않는다", async () => {
    let finish: ((value: unknown) => void) | undefined;
    mockApi({
      [prepare]: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const view = mount();
    await userEvent.type(screen.getByLabelText("실행 사유", { exact: false }), "공개 실행 점검");
    await userEvent.click(screen.getByRole("button", { name: "실행 조건 검토" }));
    view.unmount();
    await act(async () => finish?.(executionReviewFixture()));
    expect(view.onResult).not.toHaveBeenCalled();
  });
  it("시뮬레이션 선택은 실행 키를 전송하지 않는다", async () => {
    const record = executionReviewFixture({
      kind: "simulation",
      planned_live_calls: 0,
      requested_output_tokens: 0,
      targets: [
        {
          id: "t",
          target_ref: "도구 시뮬레이션",
          provider: "",
          models: [],
          live_calls: 0,
          case_executions: 1,
        },
      ],
    });
    const api = mockApi({ [prepare]: () => record, [execute]: () => executionOutcomeFixture(record) });
    mount();
    await userEvent.selectOptions(screen.getByLabelText("이번 실행 방식"), "simulation");
    await review();
    await confirm();
    expect(api.bodies(execute)).toEqual([{ review_token: record.review_token }]);
  });
  it("실제 호출에 키가 없으면 검토 요청부터 차단한다", async () => {
    const api = mockApi({});
    mount(vi.fn(), "");
    await userEvent.type(screen.getByLabelText("실행 사유", { exact: false }), "공개 실행 점검");
    await userEvent.click(screen.getByRole("button", { name: "실행 조건 검토" }));
    expect(api.bodies(prepare)).toEqual([]);
    expect(screen.queryByRole("dialog", { name: "실행 조건 최종 확인" })).toBeNull();
  });
  it.each(["id", "limits", "totals", "expired"])(
    "맞지 않는 검토 응답 %s를 실행 대상으로 표시하지 않는다",
    async (field) => {
      const record = executionReviewFixture();
      if (field === "id") record.campaign_id = "different";
      if (field === "limits") record.limits.max_calls = 21;
      if (field === "totals") record.planned_live_calls = 2;
      if (field === "expired") record.expires_at = "2000-01-01T00:00:00Z";
      mockApi({ [prepare]: () => record });
      mount();
      await userEvent.type(screen.getByLabelText("실행 사유", { exact: false }), "공개 실행 점검");
      await userEvent.click(screen.getByRole("button", { name: "실행 조건 검토" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "실행 조건 검토" })).toBeEnabled());
      expect(screen.queryByRole("dialog", { name: "실행 조건 최종 확인" })).toBeNull();
    },
  );
  it("누락된 검토·결과 집계를 기본값으로 보완하지 않는다", () => {
    expect(redTeamReviewSchema.safeParse({}).success).toBe(false);
    expect(reviewedOutcomeSchema.safeParse({}).success).toBe(false);
    const record = executionReviewFixture();
    record.case_executions = 2;
    expect(redTeamReviewSchema.safeParse(record).success).toBe(false);
    const result = executionOutcomeFixture();
    result.summary.results = 0;
    expect(reviewedOutcomeSchema.safeParse(result).success).toBe(false);
  });
  it("닫기와 같은 순간 도착한 실행 응답을 다시 열지 않는다", async () => {
    let finish: ((value: unknown) => void) | undefined;
    mockApi({
      [prepare]: () => executionReviewFixture(),
      [execute]: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const view = mount();
    await review();
    await confirm();
    const close = screen.getByRole("button", { name: "닫기" });
    await act(async () => {
      fireEvent.click(close);
      finish?.(executionOutcomeFixture());
    });
    expect(view.onClose).toHaveBeenCalledOnce();
    expect(view.onResult).not.toHaveBeenCalled();
  });
});
