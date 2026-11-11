import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { usePreferences } from "@/shared/stores/preferences";
import { mockApi, apiFailure } from "@/test/api";
import { goldenPrompts, goldenResults, goldenWorkflows } from "../../../../tests/fixtures/golden-regression";
import { RegressionPage } from "./RegressionPage";

const runtime = vi.hoisted(() => ({
  id: "public-a",
  team: "public-team",
  role: "readonly_admin",
  scopes: ["admin:read"],
  prefixes: ["corp_"],
  permitted: true,
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => ({
      ...testAuth({
        role: runtime.role,
        scopes: runtime.scopes,
        user: { id: runtime.id, team_id: runtime.team },
      }),
      credentialPrefixes: runtime.prefixes,
    }),
  };
});
function Location() {
  return <output aria-label="현재 경로">{useLocation().pathname + useLocation().search}</output>;
}
function setup(route = "/prompts/regression") {
  let readPrompts = async () => ({
    golden_prompts: structuredClone(goldenPrompts),
    results: structuredClone(goldenResults),
  });
  let readWorkflows = async () => ({ workflows: structuredClone(goldenWorkflows) });
  const api = mockApi({
    "GET /admin/golden-prompts": async ({ query }) => {
      const value = await readPrompts();
      const id = (query as { prompt_id?: string } | undefined)?.prompt_id;
      return { ...value, results: id ? value.results.filter((row) => row.prompt_id === id) : value.results };
    },
    "GET /admin/golden-workflows": () => readWorkflows(),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <FeatureAccessContext.Provider
          value={{
            featureId: "prompts.regression",
            permitted: runtime.permitted,
            readOnly: true,
            status: "preview_read_only",
          }}
        >
          <RegressionPage />
          <Location />
        </FeatureAccessContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  return {
    ...view,
    client,
    api,
    user: userEvent.setup(),
    update: () => view.rerender(tree()),
    prompts: (next: typeof readPrompts) => {
      readPrompts = next;
    },
    workflows: (next: typeof readWorkflows) => {
      readWorkflows = next;
    },
  };
}
beforeEach(() => {
  Object.assign(runtime, {
    id: "public-a",
    team: "public-team",
    role: "readonly_admin",
    scopes: ["admin:read"],
    prefixes: ["corp_"],
    permitted: true,
  });
  tokenStore.clearAll();
  usePreferences.setState({ refreshInterval: 0 });
});

it("기준·기대 내용과 대상별 최근 결과를 깊은 주소로 조회하며 실행 요청은 보내지 않는다", async () => {
  const c = setup("/prompts/regression?selection=public-prompt-a");
  const dialog = await screen.findByRole("dialog", { name: "기준 프롬프트 상세" });
  expect(await within(dialog).findByText("안녕하세요라고 답하세요.")).toBeVisible();
  expect(within(dialog).getByText("public-model-a")).toBeVisible();
  expect(within(dialog).queryByText("public-model-b")).not.toBeInTheDocument();
  expect(
    c.api.calls.some(
      (call) =>
        JSON.stringify(call.options.query) === JSON.stringify({ limit: 200, prompt_id: "public-prompt-a" }),
    ),
  ).toBe(true);
  expect(c.api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
  await c.user.click(within(dialog).getByRole("button", { name: "닫기" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByLabelText("현재 경로")).not.toHaveTextContent("selection");
});
it("검색어를 주소·저장소에 쓰지 않고 통과 필터와 페이지 상태를 주소로 관리한다", async () => {
  const c = setup("/prompts/regression?tab=results&outcome=passed");
  await screen.findByRole("link", { name: "빈 기대 내용 확인" });
  expect(screen.queryByRole("link", { name: "한글 답변 확인" })).not.toBeInTheDocument();
  await c.user.selectOptions(screen.getByLabelText("검사 결과"), "all");
  await c.user.type(screen.getByLabelText("프롬프트 이름·모델 검색"), "public-model-a");
  await waitFor(() =>
    expect(screen.queryByRole("link", { name: "빈 기대 내용 확인" })).not.toBeInTheDocument(),
  );
  expect(screen.getByLabelText("현재 경로")).not.toHaveTextContent("public-model-a");
  expect(JSON.stringify(localStorage)).not.toContain("public-model-a");
});
it("워크플로 순서와 기준 점수는 보존하고 미확인 단계를 빈 목록과 구분한다", async () => {
  const c = setup("/prompts/regression?tab=workflows&selection=public-workflow-a");
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("첫 질문");
  expect(within(dialog).getByText("82.5")).toBeVisible();
  expect(within(dialog).getByText(/앞 단계의 출력이 다음 단계로 전달되지/)).toBeVisible();
  await c.user.click(within(dialog).getByRole("button", { name: "닫기" }));
  await c.user.click(screen.getByRole("link", { name: "확인이 필요한 세트" }));
  expect(await screen.findByText("단계 정보를 확인할 수 없습니다.")).toBeVisible();
});
it("서버 오류를 성공 0건으로 바꾸지 않고 다른 조회를 유지하며 다시 시도한다", async () => {
  const c = setup();
  await screen.findByRole("link", { name: "한글 답변 확인" });
  c.workflows(async () => {
    throw apiFailure("private server error", 500, "public-request");
  });
  await c.client.invalidateQueries({ queryKey: ["prompts.regression", "workflows"] });
  await c.user.click(screen.getByRole("tab", { name: "검증 워크플로" }));
  expect(await screen.findByText("데이터를 갱신하지 못했습니다.")).toBeVisible();
  expect(screen.queryByText("private server error")).not.toBeInTheDocument();
  expect(screen.getByText("요청 ID: public-request")).toBeVisible();
  c.workflows(async () => ({ workflows: [] }));
  await c.user.click(screen.getByRole("button", { name: "다시 조회" }));
  await waitFor(() => expect(screen.queryByText("데이터를 갱신하지 못했습니다.")).not.toBeInTheDocument());
  expect(screen.getByText(/아직 등록된 항목이나 저장된 실행 결과/)).toBeVisible();
});
it.each(["id", "team", "role", "prefixes", "epoch"] as const)(
  "%s 변경은 이전 데이터와 검색 입력을 폐기한다",
  async (field) => {
    const c = setup();
    await screen.findByRole("link", { name: "한글 답변 확인" });
    c.prompts(() => new Promise(() => undefined));
    c.workflows(() => new Promise(() => undefined));
    if (field === "epoch") act(() => tokenStore.clearAll());
    else {
      if (field === "prefixes") runtime.prefixes = ["next_"];
      else runtime[field] = "public-next";
      c.update();
    }
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "한글 답변 확인" })).not.toBeInTheDocument(),
    );
    expect(
      JSON.stringify(
        c.client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain("한글 답변 확인");
  },
);
it.each([401, 403])("조회 %i은 이전 상세·캐시를 숨기고 명시적 재확인만 허용한다", async (status) => {
  const c = setup("/prompts/regression?tab=results&selection=public-result-a");
  await screen.findByText("공개 검사 응답");
  c.prompts(async () => {
    throw new AppError("denied", { kind: "permission", status });
  });
  await act(() => c.client.invalidateQueries({ queryKey: ["prompts.regression", "prompts"] }));
  expect(await screen.findByRole("heading", { name: "회귀 검증 조회 권한 확인 필요" })).toBeVisible();
  expect(screen.queryByText("공개 검사 응답")).not.toBeInTheDocument();
  expect(c.client.getQueryCache().getAll()).toHaveLength(0);
  c.prompts(async () => ({ golden_prompts: structuredClone(goldenPrompts), results: [] }));
  await c.user.click(screen.getByRole("button", { name: "권한 확인 후 다시 조회" }));
  expect(await screen.findByText("현재 조회 범위에서 항목을 찾지 못했습니다.")).toBeVisible();
});
it("조회 권한이 없으면 API 호출과 이전 정의 표시를 하지 않는다", () => {
  runtime.scopes = [];
  const c = setup();
  expect(screen.getByRole("heading", { name: "회귀 검증 조회 권한 확인 필요" })).toBeVisible();
  expect(c.api.calls).toHaveLength(0);
});

it("백그라운드 갱신으로 이름이 바뀌어도 상세 링크의 키보드 포커스를 유지한다", async () => {
  const c = setup();
  const link = await screen.findByRole("link", { name: "한글 답변 확인" });
  link.focus();
  c.prompts(async () => ({
    golden_prompts: goldenPrompts.map((row) => ({ ...row, name: `${row.name} 갱신` })),
    results: structuredClone(goldenResults),
  }));
  await act(() => c.client.invalidateQueries({ queryKey: ["prompts.regression", "prompts"] }));
  const updated = await screen.findByRole("link", { name: "한글 답변 확인 갱신" });
  expect(updated).toBe(link);
  expect(updated).toHaveFocus();
  await c.user.keyboard("{Enter}");
  expect(await screen.findByRole("dialog", { name: "기준 프롬프트 상세" })).toBeVisible();
});

it("계정 변경 후 도착한 이전 조회 응답은 새 계정의 화면과 캐시에 남지 않는다", async () => {
  const c = setup();
  await screen.findByRole("link", { name: "한글 답변 확인" });
  let finish: (() => void) | undefined;
  c.prompts(
    () =>
      new Promise((resolve) => {
        finish = () =>
          resolve({
            golden_prompts: structuredClone(goldenPrompts),
            results: structuredClone(goldenResults),
          });
      }),
  );
  const pending = c.client.invalidateQueries({ queryKey: ["prompts.regression", "prompts"] });
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  c.prompts(async () => ({ golden_prompts: [], results: [] }));
  c.workflows(async () => ({ workflows: [] }));
  runtime.id = "public-next";
  c.update();
  await waitFor(() => expect(screen.queryByRole("link", { name: "한글 답변 확인" })).not.toBeInTheDocument());
  await act(async () => {
    finish?.();
    await pending;
  });
  expect(screen.queryByRole("link", { name: "한글 답변 확인" })).not.toBeInTheDocument();
  expect(
    JSON.stringify(
      c.client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    ),
  ).not.toContain("한글 답변 확인");
});
