import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { tokenStore } from "@/shared/auth/token-store";
import { AppError } from "@/shared/api/error";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { labExperiment, labCase, labReceipt, labContract } from "../../../../tests/fixtures/prompt-lab";
import { PromptLabPage } from "./PromptLabPage";

const runtime = vi.hoisted(() => ({
  id: "public-a",
  team: "public-team",
  scopes: ["admin:read", "admin:write"],
  readOnly: false,
}));
const success = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { success } }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => ({
      ...testAuth({ scopes: runtime.scopes, user: { id: runtime.id, team_id: runtime.team } }),
      credentialPrefixes: ["corp_"],
    }),
  };
});
function Location() {
  const location = useLocation(),
    navigate = useNavigate();
  return (
    <>
      <output aria-label="현재 경로">{location.pathname + location.search}</output>
      <button onClick={() => navigate("/prompts/lab")}>목록으로 이동</button>
    </>
  );
}
function setup(extra: Record<string, ApiHandler> = {}, route = "/prompts/lab?exp=public_exp_1") {
  const api = mockApi({
    "GET /admin/prompt-lab/experiments": () => ({ experiments: [labExperiment] }),
    "GET /admin/prompt-lab/experiments/public_exp_1": () => ({
      experiment: labExperiment,
      test_cases: [labCase],
    }),
    "GET /admin/prompt-lab/contracts": () => ({ contracts: [labContract] }),
    "GET /admin/prompt-lab/rubrics": () => ({ rubrics: [] }),
    "GET /admin/prompt-lab/test-cases/public_case_1": () => ({
      test_case: labCase,
      history: labReceipt.history,
    }),
    "POST /admin/prompt-lab/test-cases/public_case_1/run": () => labReceipt,
    ...extra,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <FeatureAccessContext.Provider
          value={{ featureId: "prompts.lab", permitted: true, readOnly: runtime.readOnly, status: "preview" }}
        >
          <PromptLabPage />
          <Location />
        </FeatureAccessContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, client, api, user: userEvent.setup(), update: () => view.rerender(tree()) };
}
async function openRun(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "한글 요약 검사 테스트 케이스 실행" }));
  return within(await screen.findByRole("dialog"));
}
beforeEach(() => {
  Object.assign(runtime, {
    id: "public-a",
    team: "public-team",
    scopes: ["admin:read", "admin:write"],
    readOnly: false,
  });
  tokenStore.clearAll();
  success.mockClear();
});
describe("프롬프트 실험실 상태와 실행 경계", () => {
  it("preserves a draft when readonly changes and blocks submission", async () => {
    const view = setup();
    await view.user.click(await screen.findByRole("button", { name: "실험 만들기" }));
    const dialog = within(screen.getByRole("dialog"));
    await view.user.type(dialog.getByLabelText(/^제목/), "유지할 초안");
    runtime.readOnly = true;
    view.update();
    expect(dialog.getByLabelText(/^제목/)).toHaveValue("유지할 초안");
    expect(dialog.getByRole("button", { name: "저장" })).toBeDisabled();
    runtime.readOnly = false;
    view.update();
    expect(dialog.getByRole("button", { name: "저장" })).toBeEnabled();
    expect(view.api.calls.every((row) => row.key.startsWith("GET"))).toBe(true);
  });
  it("clears the old draft and queries on an account change", async () => {
    const view = setup();
    await view.user.click(await screen.findByRole("button", { name: "실험 만들기" }));
    await view.user.type(within(screen.getByRole("dialog")).getByLabelText(/^제목/), "이전 계정 초안");
    const hashes = view.client
      .getQueryCache()
      .getAll()
      .map((row) => row.queryHash);
    runtime.id = "public-b";
    view.update();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      view.client
        .getQueryCache()
        .getAll()
        .every((row) => !hashes.includes(row.queryHash)),
    ).toBe(true);
    await view.user.click(await screen.findByRole("button", { name: "실험 만들기" }));
    expect(within(screen.getByRole("dialog")).getByLabelText(/^제목/)).toHaveValue("");
  });
  it("hides all prior data after a read denial and requires an explicit retry", async () => {
    let denied = false;
    const view = setup({
      "GET /admin/prompt-lab/experiments": () => {
        if (denied) throw apiFailure("private body", 403);
        return { experiments: [labExperiment] };
      },
    });
    await screen.findByText(labCase.name);
    denied = true;
    await view.user.click(screen.getByRole("button", { name: "새로고침" }));
    expect(
      await screen.findByRole("heading", { name: "프롬프트 실험실 조회 권한 확인 필요" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(labCase.name)).not.toBeInTheDocument();
    denied = false;
    await view.user.click(screen.getByRole("button", { name: "권한 확인 후 다시 조회" }));
    expect(await screen.findByText(labCase.name)).toBeInTheDocument();
  });
  it("rechecks the saved case and refuses a changed model before sending", async () => {
    let changed = false;
    const view = setup({
      "GET /admin/prompt-lab/experiments/public_exp_1": () => ({
        experiment: labExperiment,
        test_cases: [{ ...labCase, ...(changed ? { models_json: '["changed-model"]' } : {}) }],
      }),
    });
    const dialog = await openRun(view.user);
    changed = true;
    await view.user.click(dialog.getByRole("button", { name: "실행" }));
    expect(await dialog.findByText(/최신 내용을 조회한 뒤/)).toBeInTheDocument();
    expect(view.api.bodies("POST /admin/prompt-lab/test-cases/public_case_1/run")).toHaveLength(0);
  });
  it("keeps unknown execution locked across closing and reopening the dialog", async () => {
    const view = setup({
      "POST /admin/prompt-lab/test-cases/public_case_1/run": () => {
        throw new AppError("private error", { kind: "network" });
      },
    });
    let dialog = await openRun(view.user);
    await view.user.click(dialog.getByRole("button", { name: "실행" }));
    await dialog.findByText("이전 작업 결과 확인 필요");
    expect(dialog.getByRole("button", { name: "실행" })).toBeDisabled();
    await view.user.click(dialog.getByRole("button", { name: "취소" }));
    dialog = await openRun(view.user);
    expect(dialog.getByRole("button", { name: "실행" })).toBeDisabled();
    expect(view.api.bodies("POST /admin/prompt-lab/test-cases/public_case_1/run")).toHaveLength(1);
  });
  it("does not replay a rejected write after 401", async () => {
    const view = setup({
      "POST /admin/prompt-lab/test-cases/public_case_1/run": () => {
        throw apiFailure("private body", 401);
      },
    });
    const dialog = await openRun(view.user);
    await view.user.click(dialog.getByRole("button", { name: "실행" }));
    await dialog.findByText(/인증 정보가/);
    const calls = view.api.spy.mock.calls.filter(([endpoint]) => endpoint.method === "POST");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toMatchObject({ retryUnauthorized: false });
  });
  it("ignores a late run result after changing the selected experiment", async () => {
    let finish!: (result: typeof labReceipt) => void;
    const view = setup({
      "POST /admin/prompt-lab/test-cases/public_case_1/run": () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const dialog = await openRun(view.user);
    await view.user.click(dialog.getByRole("button", { name: "실행" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    // Route changes can also come from the browser or another shell command while a dialog is pending.
    await act(async () => {
      screen.getByText("목록으로 이동").click();
    });
    await act(async () => finish(labReceipt));
    expect(success).not.toHaveBeenCalled();
    expect(screen.queryByText(/최고 점수 모델 public-model-a/)).not.toBeInTheDocument();
  });
  it("ignores completion after write permission is removed and restored", async () => {
    let finish!: (result: typeof labReceipt) => void;
    const view = setup({
      "POST /admin/prompt-lab/test-cases/public_case_1/run": () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const dialog = await openRun(view.user);
    await view.user.click(dialog.getByRole("button", { name: "실행" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    runtime.readOnly = true;
    view.update();
    runtime.readOnly = false;
    view.update();
    await act(async () => finish(labReceipt));
    await dialog.findByText("이전 작업 결과 확인 필요");
    expect(success).not.toHaveBeenCalled();
  });
  it("blocks a second request while a prior route's execution is still pending", async () => {
    let finish!: (result: typeof labReceipt) => void;
    const view = setup({
      "POST /admin/prompt-lab/test-cases/public_case_1/run": () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    let dialog = await openRun(view.user);
    await view.user.click(dialog.getByRole("button", { name: "실행" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    await act(async () => screen.getByText("목록으로 이동").click());
    const link = await screen.findByRole("link", { name: "요약 품질 비교 테스트 케이스 보기" });
    expect(link).toHaveAttribute("href", "/prompts/lab?exp=public_exp_1");
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    await view.user.click(screen.getByRole("link", { name: "요약 품질 비교 테스트 케이스 보기" }));
    await waitFor(() =>
      expect(screen.getByLabelText("현재 경로")).toHaveTextContent("/prompts/lab?exp=public_exp_1"),
    );
    dialog = await openRun(view.user);
    await view.user.click(dialog.getByRole("button", { name: "실행" }));
    await dialog.findByText(/진행 중인 실험실 작업/);
    expect(view.api.bodies("POST /admin/prompt-lab/test-cases/public_case_1/run")).toHaveLength(1);
    await act(async () => finish(labReceipt));
    expect(success).not.toHaveBeenCalled();
  });
  it("shows missing saved models and prevents execution", async () => {
    const view = setup({
      "GET /admin/prompt-lab/experiments/public_exp_1": () => ({
        experiment: labExperiment,
        test_cases: [{ ...labCase, models_json: "[]" }],
      }),
    });
    const dialog = await openRun(view.user);
    expect(dialog.getByText("모델 설정 확인 필요")).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "실행" })).toBeDisabled();
    expect(view.api.bodies("POST /admin/prompt-lab/test-cases/public_case_1/run")).toHaveLength(0);
  });
  it("requires the receipt to describe exactly the reviewed models", async () => {
    const view = setup({
      "POST /admin/prompt-lab/test-cases/public_case_1/run": () => ({ ...labReceipt, results: [] }),
    });
    const dialog = await openRun(view.user);
    await view.user.click(dialog.getByRole("button", { name: "실행" }));
    await dialog.findByText("이전 작업 결과 확인 필요");
    expect(success).not.toHaveBeenCalled();
  });
  it("does not claim a delete succeeded without a complete acknowledgement", async () => {
    const view = setup({ "DELETE /admin/prompt-lab/experiments/public_exp_1": () => ({}) });
    await view.user.click(await screen.findByRole("button", { name: "요약 품질 비교 실험 삭제" }));
    const dialog = within(screen.getByRole("dialog"));
    await view.user.click(dialog.getByRole("button", { name: "삭제" }));
    await dialog.findByText("이전 작업 결과 확인 필요");
    expect(dialog.getByRole("button", { name: "삭제" })).toBeDisabled();
    expect(success).not.toHaveBeenCalled();
  });
  it("opens stored history and returns focus to its trigger", async () => {
    const view = setup();
    const trigger = await screen.findByRole("button", { name: "한글 요약 검사 실행 이력" });
    await view.user.click(trigger);
    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByText("public_run_1")).toBeInTheDocument();
    expect(dialog.getByText("₩0")).toBeInTheDocument();
    await view.user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });
  it("rejects history belonging to another experiment", async () => {
    const view = setup({
      "GET /admin/prompt-lab/test-cases/public_case_1": () => ({
        test_case: { ...labCase, experiment_id: "another" },
        history: labReceipt.history,
      }),
    });
    await view.user.click(await screen.findByRole("button", { name: "한글 요약 검사 실행 이력" }));
    await screen.findByText("실행 이력을 불러오지 못했습니다.");
    expect(screen.queryByText("public_run_1")).not.toBeInTheDocument();
  });
  it("retries history errors without repeating a model call", async () => {
    let failed = true;
    const view = setup({
      "GET /admin/prompt-lab/test-cases/public_case_1": () => {
        if (failed) throw apiFailure("public failure", 500, "public_request_1");
        return {
          test_case: labCase,
          history: [{ ...labReceipt.history[0], avg_cost_krw: null, avg_score: null }],
        };
      },
    });
    await view.user.click(await screen.findByRole("button", { name: "한글 요약 검사 실행 이력" }));
    await screen.findByText("요청 ID: public_request_1");
    failed = false;
    await view.user.click(screen.getByRole("button", { name: "이력 새로고침" }));
    const dialog = within(screen.getByRole("dialog"));
    await dialog.findByText("public_run_1");
    expect(dialog.getAllByText("—")).toHaveLength(2);
    expect(view.api.calls.every((row) => row.key.startsWith("GET"))).toBe(true);
  });
  it("drops unknown bodies and masks configured secrets before Query cache", async () => {
    const secret = `corp_${"x".repeat(36)}`,
      raw = "public-raw-body-sentinel";
    const view = setup({
      "GET /admin/prompt-lab/experiments": () => ({
        experiments: [{ ...labExperiment, description: secret, private_body: raw }],
      }),
      "GET /admin/prompt-lab/experiments/public_exp_1": () => ({
        experiment: labExperiment,
        test_cases: [{ ...labCase, name: secret, messages_json: raw }],
      }),
    });
    await screen.findByText("민감한 내용은 숨겼습니다.");
    const cached = JSON.stringify(
      view.client
        .getQueryCache()
        .getAll()
        .map((row) => row.state.data),
    );
    expect(cached).not.toContain(secret);
    expect(cached).not.toContain(raw);
    expect(document.body.textContent).not.toContain(secret);
  });
  it("filters and pages through URL state without storing secret search text", async () => {
    const rows = Array.from({ length: 27 }, (_, index) => ({
      ...labExperiment,
      id: `public_${index}`,
      title: `공개 실험 ${String(index).padStart(2, "0")}`,
    }));
    const view = setup(
      { "GET /admin/prompt-lab/experiments": () => ({ experiments: rows }) },
      "/prompts/lab?sort=name&page=2",
    );
    expect(await screen.findByRole("link", { name: "공개 실험 25 테스트 케이스 보기" })).toBeInTheDocument();
    const input = screen.getByLabelText("실험 검색");
    await view.user.type(input, `corp_${"x".repeat(36)}`);
    await view.user.click(screen.getByRole("button", { name: "검색" }));
    expect(screen.getByLabelText("현재 경로")).toHaveTextContent("/prompts/lab?sort=name&page=2");
    expect(input).toHaveFocus();
    await view.user.clear(input);
    await view.user.type(input, "공개 실험 00");
    await view.user.click(screen.getByRole("button", { name: "검색" }));
    expect(await screen.findByRole("link", { name: "공개 실험 00 테스트 케이스 보기" })).toBeInTheDocument();
    expect(screen.getByLabelText("현재 경로").textContent).not.toContain("page=2");
  });
});
