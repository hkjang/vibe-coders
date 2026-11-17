import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flightRecorderResponseSchema } from "@/shared/api/domains/observability.schemas";
import { SessionPage } from "./SessionPage";
import { readSessionPage } from "./session-page-state";
import { apiClient } from "@/shared/api/client";
import { AppError } from "@/shared/api/error";
import { sessionExplorerPageSchema } from "@/shared/api/domains/session-page.schema";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { sanitizeAppRouteSearch } from "@/shared/security/app-route-query";
import { usePreferences } from "@/shared/stores/preferences";

const runtime = vi.hoisted(() => ({
  team: "team-a",
  user: "reader-a",
  scopes: ["admin:read"],
  version: "v0.86.153",
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({
        backendVersion: runtime.version,
        scopes: runtime.scopes,
        user: { id: runtime.user, team_id: runtime.team },
      }),
  };
});
const row = {
  row_key: `session_${"a".repeat(43)}`,
  session_id: "session-0",
  requests: 2,
  errors: 1,
  models: 1,
  api_keys: 1,
  total_tokens: 100,
  cost_krw: 5,
  first_seen: "2026-11-17T00:00:00Z",
  last_seen: "2026-11-17T01:00:00Z",
  last_message: "마스킹된 질문",
};
const page = {
  session_page_version: 1,
  days: 7,
  limit: 25,
  offset: 0,
  from: "2026-11-10T02:00:00Z",
  to: "2026-11-17T02:00:00Z",
  sessions: [row],
  summary: { sessions: 225, requests: 450, errors: 225, total_tokens: 22500, cost_krw: 1125 },
};
function Probe() {
  const l = useLocation(),
    navigate = useNavigate();
  return (
    <>
      <output aria-label="현재 주소">{l.search}</output>
      <button onClick={() => void navigate(-1)}>기록 뒤로</button>
    </>
  );
}
function setup(entry = "/observability/sessions") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <FeatureAccessContext.Provider
          value={{
            featureId: "observability.sessions",
            permitted: true,
            readOnly: true,
            status: "preview_read_only",
          }}
        >
          <SessionPage />
          <Probe />
        </FeatureAccessContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...render(view()), client, view };
}
function mockRequest() {
  return vi.spyOn(apiClient, "request").mockImplementation(async (endpoint, options) => {
    expect(endpoint.path).toBe("/admin/sessions/page");
    const query = options?.query as { days: number; limit: number; offset: number; q?: string };
    return {
      ...page,
      days: query.days,
      limit: query.limit,
      offset: query.offset,
      sessions: query.offset < 225 ? [{ ...row, session_id: `session-${query.offset}` }] : [],
    } as never;
  });
}
describe("기간 전체 세션 탐색", () => {
  beforeEach(() => {
    Object.assign(runtime, {
      team: "team-a",
      user: "reader-a",
      scopes: ["admin:read"],
      version: "v0.86.153",
    });
    usePreferences.setState({ refreshInterval: 0 });
  });
  it("서버 합계를 표시하고 페이지 이동, 크기 변경, 뒤로 가기와 초점을 유지한다", async () => {
    const request = mockRequest();
    const { container } = setup();
    const user = userEvent.setup();
    await screen.findByText("session-0");
    expect(
      within(screen.getByRole("region", { name: "검색 범위 전체 세션 요약" })).getAllByText("225"),
    ).toHaveLength(2);
    expect(await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).toHaveProperty(
      "violations",
      [],
    );
    const next = screen.getByRole("button", { name: "다음 세션" });
    await user.click(next);
    await screen.findByText("session-25");
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute("aria-disabled", "false");
    expect(screen.getByLabelText("현재 주소")).toHaveTextContent("offset=25");
    expect(request.mock.calls.at(-1)?.[1]?.query).toEqual({ days: 7, limit: 25, offset: 25, q: undefined });
    await user.selectOptions(screen.getByLabelText("페이지당 세션 수"), "50");
    await screen.findByText("session-0");
    expect(screen.getByLabelText("현재 주소")).toHaveTextContent("page_size=50");
    expect(screen.getByLabelText("현재 주소")).not.toHaveTextContent("offset");
    await user.click(screen.getByRole("button", { name: "기록 뒤로" }));
    await screen.findByText("session-25");
  });
  it("세션 ID 검색은 서버로 전달하고 첫 페이지로 이동한다", async () => {
    const request = mockRequest();
    setup("/observability/sessions?offset=200");
    const user = userEvent.setup();
    await screen.findByText("session-200");
    await user.type(screen.getByLabelText("세션 ID 검색"), "세션-찾기");
    await user.click(screen.getByRole("button", { name: "조회" }));
    await waitFor(() =>
      expect(request.mock.calls.at(-1)?.[1]?.query).toEqual({
        days: 7,
        limit: 25,
        offset: 0,
        q: "세션-찾기",
      }),
    );
    expect(screen.getByText(/메시지 내용은 검색하지 않습니다/)).toBeInTheDocument();
  });
  it.each([false, true])(
    "URL 필터가 없어도 미제출 초안과 오류를 초기화한다 (검증 오류: %s)",
    async (invalid) => {
      const request = mockRequest();
      setup();
      const user = userEvent.setup();
      await screen.findByText("session-0");
      const days = screen.getByLabelText("조회 기간(일)");
      const search = screen.getByLabelText("세션 ID 검색");
      await user.clear(days);
      await user.type(days, "30");
      await user.type(search, invalid ? "x".repeat(257) : "미제출");
      if (invalid) {
        await user.click(screen.getByRole("button", { name: "조회" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("256바이트");
      }
      expect(screen.getByLabelText("현재 주소")).toBeEmptyDOMElement();
      const calls = request.mock.calls.length;
      const reset = screen.getByRole("button", { name: "초기화" });
      await user.click(reset);
      expect(search).toHaveValue("");
      expect(days).toHaveValue(7);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(reset).toHaveFocus();
      expect(screen.getByLabelText("현재 주소")).toBeEmptyDOMElement();
      expect(request).toHaveBeenCalledTimes(calls);
    },
  );
  it("빈 뒷페이지에서도 전체 합계와 처음 이동을 유지한다", async () => {
    mockRequest();
    setup("/observability/sessions?offset=250");
    await screen.findByText(/현재 페이지에 세션이 없습니다/);
    expect(screen.getByRole("button", { name: "다음 세션" })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(screen.getByRole("button", { name: "처음" }));
    await screen.findByText("session-0");
  });
  it("조회 실패를 빈 결과와 구분하고 권한 거부 뒤 명시적으로 다시 조회한다", async () => {
    const request = mockRequest();
    const { client } = setup();
    await screen.findByText("session-0");
    request.mockRejectedValueOnce(new AppError("private upstream detail", { kind: "http", status: 403 }));
    await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await screen.findByText("세션 목록 조회가 거부되었습니다.");
    expect(screen.queryByText("session-0")).not.toBeInTheDocument();
    expect(screen.queryByText("private upstream detail")).not.toBeInTheDocument();
    expect(
      client
        .getQueryCache()
        .getAll()
        .every((query) => query.state.data === undefined),
    ).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "권한 확인 후 다시 조회" }));
    await screen.findByText("session-0");
  });
  it("계정 변경은 진행 중 응답과 이전 행을 폐기한다", async () => {
    let finish!: (value: typeof page) => void;
    let signal: AbortSignal | undefined;
    const request = mockRequest();
    request.mockImplementationOnce(async (_, options) => {
      signal = options?.signal;
      return (await new Promise<typeof page>((resolve) => {
        finish = resolve;
      })) as never;
    });
    const rendered = setup();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    runtime.user = "reader-b";
    rendered.rerender(rendered.view());
    await screen.findByText("session-0");
    expect(signal?.aborted).toBe(true);
    await act(async () => finish({ ...page, sessions: [{ ...row, session_id: "retired-session" }] }));
    expect(screen.queryByText("retired-session")).not.toBeInTheDocument();
  });
  it("현재 행에서 비행기록을 열고 주소 조건과 닫기 초점을 보존한다", async () => {
    const request = mockRequest();
    request.mockImplementation(async (endpoint, options) => {
      if (endpoint.path.endsWith("/flight-recorder"))
        return flightRecorderResponseSchema.parse({ session_id: "session-25", events: [] }) as never;
      const query = options?.query as { days: number; limit: number; offset: number };
      return { ...page, ...query, sessions: [{ ...row, session_id: "session-25" }] } as never;
    });
    setup("/observability/sessions?offset=25&q=session");
    const trigger = await screen.findByRole("button", { name: "session-25 세션 비행기록 열기" });
    await userEvent.click(trigger);
    await screen.findByRole("dialog");
    expect(screen.getByLabelText("현재 주소")).toHaveTextContent("offset=25");
    expect(screen.getByLabelText("현재 주소")).toHaveTextContent("session_id=session-25");
    await waitFor(() =>
      expect(request.mock.calls.some((call) => call[0].path.endsWith("/session-25/flight-recorder"))).toBe(
        true,
      ),
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    const previous = screen.getByRole("button", { name: "이전 세션" });
    await userEvent.click(previous);
    await waitFor(() => expect(previous).toHaveAttribute("aria-disabled", "true"));
    expect(previous).toHaveFocus();
    const calls = request.mock.calls.length;
    await userEvent.keyboard("{Enter}");
    expect(request).toHaveBeenCalledTimes(calls);
  });
  it("새 API 실패 시 기존 목록을 자동 호출하지 않는다", async () => {
    const request = vi
      .spyOn(apiClient, "request")
      .mockRejectedValue(new AppError("missing", { kind: "http", status: 404 }));
    setup();
    await screen.findByText("세션 목록을 불러오지 못했습니다.");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0].path).toBe("/admin/sessions/page");
  });
  it("조회 주소와 응답 계약을 엄격하게 검증한다", () => {
    for (const search of [
      "days=0",
      "days=01",
      "days=7&days=8",
      "page_size=10",
      "offset=1",
      "offset=1000001",
      "q=a&q=b",
      "q=%0A",
      "q=" + "가".repeat(86),
    ])
      expect(readSessionPage(new URLSearchParams(search), []).valid, search).toBe(false);
    expect(readSessionPage(new URLSearchParams("days=30&page_size=50&offset=250&q=한글"), []).valid).toBe(
      true,
    );
    expect(sessionExplorerPageSchema.safeParse(page).success).toBe(true);
    for (const change of [
      { sessions: [row, row] },
      { summary: { ...page.summary, sessions: 0 } },
      { offset: 1 },
      { session_page_version: 2 },
      { extra: "raw" },
    ])
      expect(sessionExplorerPageSchema.safeParse({ ...page, ...change }).success).toBe(false);
    const sanitized = sanitizeAppRouteSearch(
      "/app/observability/sessions",
      "?days=30&q=한글&page_size=50&offset=250&session_id=sess-a",
    );
    expect(new URLSearchParams(sanitized.search).get("page_size")).toBe("50");
    expect(new URLSearchParams(sanitized.search).get("offset")).toBe("250");
  });
  it.each(["x", "가", "🙂"])("미리보기 %s는 말줄임표를 포함해 160코드포인트까지만 허용한다", (unit) => {
    for (const value of [unit.repeat(159), unit.repeat(160), unit.repeat(159) + "…"])
      expect(
        sessionExplorerPageSchema.safeParse({ ...page, sessions: [{ ...row, last_message: value }] }).success,
      ).toBe(true);
    expect(
      sessionExplorerPageSchema.safeParse({
        ...page,
        sessions: [{ ...row, last_message: unit.repeat(160) + "…" }],
      }).success,
    ).toBe(false);
  });
});
