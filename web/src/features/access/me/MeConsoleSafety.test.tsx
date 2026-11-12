import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouteQueryGuard } from "@/app/guards/RouteQueryGuard";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { MePage } from "./MePage";

const runtime = vi.hoisted(() => ({ id: "public-user", team: "public-team", readOnly: false }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => ({
      ...testAuth({ role: "developer", scopes: [], user: { id: runtime.id, team_id: runtime.team } }),
      credentialPrefixes: ["public_credential_"],
    }),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const skill = {
  name: "public-skill",
  description: "공개 스킬",
  risk_level: "low",
  runs_30d: 100,
  success_rate: 1,
  users_30d: 4,
  satisfaction: 4,
  feedback_count: 3,
};
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(route = "/me", handlers: Record<string, ApiHandler> = {}) {
  const api = mockApi({
    "GET /me/dashboard": () => ({ user_id: runtime.id }),
    "GET /me/actions": () => ({ user_id: runtime.id, count: 0, actions: [] }),
    "GET /me/notifications": () => ({ user_id: runtime.id, count: 0, critical_count: 0, notifications: [] }),
    "GET /me/report": () => ({ user_id: runtime.id, window: "weekly" }),
    "GET /me/skills": () => ({ team: runtime.team, available: [skill], requestable: [] }),
    "GET /me/recommendations": () => ({ user_id: runtime.id, recommendations: [] }),
    "GET /me/requests": () => ({ requests: [] }),
    "GET /me/recommended-models": () => ({ task_recommendations: [], your_models: [], team_winners: [] }),
    "GET /me/requests/public-request/receipt": () => ({ request_id: "public-request", model: "공개 모델" }),
    ...handlers,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <LocationProbe />
        <Routes>
          <Route element={<RouteQueryGuard />}>
            <Route
              path="/me/*"
              element={
                <FeatureAccessContext.Provider
                  value={{
                    featureId: "me.home",
                    permitted: true,
                    status: "preview",
                    readOnly: runtime.readOnly,
                  }}
                >
                  <MePage />
                </FeatureAccessContext.Provider>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const rendered = render(tree());
  return { ...rendered, api, client, refresh: () => rendered.rerender(tree()) };
}
beforeEach(() => {
  runtime.id = "public-user";
  runtime.team = "public-team";
  runtime.readOnly = false;
});

describe("personal console ownership and data contracts", () => {
  it.each([401, 403])("does not replay a denied feedback write (%s)", async (status) => {
    const user = userEvent.setup();
    const app = setup("/me?tab=skills", {
      "GET /me/recommendations": () => ({
        user_id: runtime.id,
        recommendations: [{ id: "public-rec", user_id: runtime.id, kind: "template", title: "공개 추천" }],
      }),
      "POST /me/recommendations/public-rec/feedback": () => {
        throw apiFailure("private write error", status);
      },
    });
    await user.click(await screen.findByRole("button", { name: "나중에" }));
    await screen.findByRole("heading", { name: "개인 조회 권한을 확인하세요." });
    expect(app.api.bodies("POST /me/recommendations/public-rec/feedback")).toHaveLength(1);
    expect(screen.queryByText("공개 추천")).not.toBeInTheDocument();
    expect(
      app.client
        .getQueryCache()
        .getAll()
        .some((q) => q.queryKey.includes("me-console-read")),
    ).toBe(false);
  });
  it("does not accept a successful HTTP response for another skill", async () => {
    const user = userEvent.setup();
    const app = setup("/me?tab=skills", {
      "GET /me/skills": () => ({ team: runtime.team, available: [], requestable: [skill] }),
      "POST /me/skills/public-skill/request-access": () => ({ status: "requested", skill: "other-skill" }),
    });
    await user.click(await screen.findByRole("button", { name: "접근 신청" }));
    await user.type(screen.getByRole("textbox", { name: /신청 사유/u }), "공개 검토 사유");
    await user.click(screen.getByRole("button", { name: "신청" }));
    const dialog = screen.getByRole("dialog", { name: "스킬 접근 신청" });
    await within(dialog).findByRole("alert");
    expect(within(dialog).getByRole("button", { name: "신청" })).toBeDisabled();
    expect(within(dialog).getByRole("textbox", { name: /신청 사유/u })).toHaveValue("공개 검토 사유");
    expect(app.api.bodies("POST /me/skills/public-skill/request-access")).toHaveLength(1);
  });
  it("does not display a failed statistics component as a zero success rate", async () => {
    setup("/me?tab=skills", {
      "GET /me/skills": () => ({
        team: runtime.team,
        available: [{ ...skill, success_rate: 0 }],
        partial_failures: ["runs"],
      }),
    });
    await screen.findByText("public-skill");
    expect(screen.getByText("성공률 —")).toBeVisible();
    expect(screen.queryByText(/성공률 0(?:\.0)?%/u)).not.toBeInTheDocument();
    expect(screen.getByText("일부 정보를 확인하지 못했습니다.")).toBeVisible();
  });
  it("does not display another user's dashboard envelope", async () => {
    const { client } = setup("/me", {
      "GET /me/dashboard": () => ({ user_id: "other-user", profile: { summary: "다른 계정 비공개 요약" } }),
    });
    await screen.findAllByRole("alert");
    expect(screen.queryByText("다른 계정 비공개 요약")).not.toBeInTheDocument();
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain("다른 계정 비공개 요약");
  });
  it("keeps missing usage distinct from a measured zero", async () => {
    setup();
    const region = await screen.findByRole("region", { name: "내 사용 요약" });
    const card = within(region).getByText("오늘 요청").closest("article");
    expect(card).toHaveTextContent("—");
    expect(card).not.toHaveTextContent("오늘 요청0");
  });
  it("uses the skill endpoint's percentage unit even below one percent", async () => {
    setup("/me?tab=skills");
    await screen.findByText("public-skill");
    expect(screen.getByText(/성공률 1(?:\.0)?%/u)).toBeVisible();
    expect(screen.queryByText(/성공률 100(?:\.0)?%/u)).not.toBeInTheDocument();
  });
  it("can explicitly generate recommendations again without background generation", async () => {
    const user = userEvent.setup();
    const { api } = setup("/me?tab=skills");
    await screen.findByText("public-skill");
    expect(
      api.calls.filter(
        (c) => c.key === "GET /me/recommendations" && (c.options.query as { refresh?: boolean })?.refresh,
      ),
    ).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: /추천 (불러오기|새로 계산)/u }));
    await waitFor(() =>
      expect(
        api.calls.filter(
          (c) => c.key === "GET /me/recommendations" && (c.options.query as { refresh?: boolean })?.refresh,
        ),
      ).toHaveLength(1),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /추천 (불러오기|새로 계산)/u })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: /추천 (불러오기|새로 계산)/u }));
    await waitFor(() =>
      expect(
        api.calls.filter(
          (c) => c.key === "GET /me/recommendations" && (c.options.query as { refresh?: boolean })?.refresh,
        ),
      ).toHaveLength(2),
    );
  });
  it("blocks recommendation generation in read-only mode", async () => {
    runtime.readOnly = true;
    const { api } = setup("/me?tab=skills");
    await screen.findByText("public-skill");
    expect(screen.getByRole("button", { name: /추천 (불러오기|새로 계산)/u })).toBeDisabled();
    expect(
      api.calls.filter(
        (c) => c.key === "GET /me/recommendations" && (c.options.query as { refresh?: boolean })?.refresh,
      ),
    ).toHaveLength(0);
  });
  it("opens a receipt directly independently of the recent request list", async () => {
    const { api } = setup("/me?tab=requests&receipt=public-request");
    const dialog = await screen.findByRole("dialog", { name: "요청 영수증" });
    expect(await within(dialog).findByText("공개 모델")).toBeVisible();
    expect(api.calls.filter((c) => c.key === "GET /me/requests/public-request/receipt")).toHaveLength(1);
  });
  it("discards a late response after changing accounts", async () => {
    const old = deferred<unknown>();
    const app = setup("/me", {
      "GET /me/dashboard": () =>
        runtime.id === "public-user"
          ? old.promise
          : { user_id: runtime.id, profile: { summary: "현재 계정 요약" } },
    });
    await waitFor(() => expect(app.api.calls.some((c) => c.key === "GET /me/dashboard")).toBe(true));
    runtime.id = "new-user";
    app.refresh();
    await screen.findByText("현재 계정 요약");
    await act(async () => old.resolve({ user_id: "public-user", profile: { summary: "이전 계정 요약" } }));
    expect(screen.queryByText("이전 계정 요약")).not.toBeInTheDocument();
    expect(
      JSON.stringify(
        app.client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain("이전 계정 요약");
  });
  it.each([401, 403])(
    "retires personal reads after HTTP %s and waits for manual recovery",
    async (status) => {
      let fail = false;
      const app = setup("/me", {
        "GET /me/dashboard": () => {
          if (fail)
            throw apiFailure("public_credential_private_error", status, "public_credential_request_id");
          return { user_id: runtime.id, profile: { summary: "폐기할 개인 요약" } };
        },
      });
      await screen.findByText("폐기할 개인 요약");
      fail = true;
      await act(async () => {
        await app.client.invalidateQueries({ queryKey: ["me"] });
      });
      await screen.findByRole("heading", { name: "개인 조회 권한을 확인하세요." });
      expect(screen.queryByText("폐기할 개인 요약")).not.toBeInTheDocument();
      expect(
        app.client
          .getQueryCache()
          .getAll()
          .some((q) => q.queryKey.includes("me-console-read")),
      ).toBe(false);
      fail = false;
      app.refresh();
      expect(screen.queryByText("폐기할 개인 요약")).not.toBeInTheDocument();
      await userEvent.setup().click(screen.getByRole("button", { name: "권한 확인 후 다시 조회" }));
      expect(await screen.findByText("폐기할 개인 요약")).toBeVisible();
    },
  );
  it("rejects another team's skill list before caching", async () => {
    const app = setup("/me?tab=skills", {
      "GET /me/skills": () => ({ team: "other-team", available: [{ ...skill, name: "비공개 팀 스킬" }] }),
    });
    await screen.findAllByRole("alert");
    expect(screen.queryByText("비공개 팀 스킬")).not.toBeInTheDocument();
    expect(
      JSON.stringify(
        app.client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain("비공개 팀 스킬");
  });
  it("drops unknown raw fields and masks credential-looking metadata before caching", async () => {
    const app = setup("/me", {
      "GET /me/dashboard": () => ({
        user_id: runtime.id,
        profile: { summary: "public_credential_abcdefghijklmnopqrstuvwxyzABCDEF" },
        raw_prompt: "raw-prompt-fixture",
        recommended_templates: [
          {
            id: "public-template",
            name: "공개 템플릿",
            body: "private-template-body",
            description: "public_credential_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",
          },
        ],
      }),
    });
    await screen.findByText("공개 템플릿");
    const cached = JSON.stringify(
      app.client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    );
    for (const forbidden of [
      "public_credential_abcdefghijklmnopqrstuvwxyzABCDEF",
      "private-template-body",
      "raw-prompt-fixture",
      "public_credential_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",
    ])
      expect(cached).not.toContain(forbidden);
  });
  it("rejects mismatched receipt IDs and never renders the body", async () => {
    setup("/me?tab=requests&receipt=public-request", {
      "GET /me/requests/public-request/receipt": () => ({
        request_id: "other-request",
        model: "비공개 모델",
      }),
    });
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("alert");
    expect(screen.queryByText("비공개 모델")).not.toBeInTheDocument();
  });
  it("keeps an access-request draft while read-only mode blocks transmission", async () => {
    const user = userEvent.setup();
    const app = setup("/me?tab=skills", {
      "GET /me/skills": () => ({ team: runtime.team, available: [], requestable: [skill] }),
    });
    await user.click(await screen.findByRole("button", { name: "접근 신청" }));
    await user.type(screen.getByRole("textbox", { name: /신청 사유/u }), "공개 검토 사유");
    runtime.readOnly = true;
    app.refresh();
    expect(screen.getByRole("textbox", { name: /신청 사유/u })).toHaveValue("공개 검토 사유");
    expect(screen.getByRole("button", { name: "신청" })).toBeDisabled();
    expect(app.api.bodies("POST /me/skills/public-skill/request-access")).toHaveLength(0);
    runtime.readOnly = false;
    app.refresh();
    expect(screen.getByRole("textbox", { name: /신청 사유/u })).toHaveValue("공개 검토 사유");
    expect(screen.getByRole("button", { name: "신청" })).toBeEnabled();
  });
  it("does not put secret-bearing form input into mutation variables", async () => {
    const user = userEvent.setup();
    const app = setup("/me?tab=skills", {
      "GET /me/skills": () => ({ team: runtime.team, available: [], requestable: [skill] }),
    });
    await user.click(await screen.findByRole("button", { name: "접근 신청" }));
    await user.type(
      screen.getByRole("textbox", { name: /신청 사유/u }),
      "public_credential_0123456789abcdefghijklmnopqrstuv",
    );
    await user.click(screen.getByRole("button", { name: "신청" }));
    await screen.findByText("비밀값과 제어 문자는 입력할 수 없습니다.");
    expect(app.api.bodies("POST /me/skills/public-skill/request-access")).toHaveLength(0);
    expect(
      JSON.stringify(
        app.client
          .getMutationCache()
          .getAll()
          .map((m) => m.state.variables),
      ),
    ).not.toContain("public_credential_0123456789abcdefghijklmnopqrstuv");
    expect(screen.getByRole("textbox", { name: /신청 사유/u })).toHaveFocus();
  });
  it("keeps recommendation feedback separate from regeneration", async () => {
    const user = userEvent.setup();
    const app = setup("/me?tab=skills", {
      "GET /me/recommendations": () => ({
        user_id: runtime.id,
        recommendations: [{ id: "public-rec", user_id: runtime.id, kind: "template", title: "공개 추천" }],
      }),
      "POST /me/recommendations/public-rec/feedback": () => ({
        status: "recorded",
        kind: "template",
        action: "later",
      }),
    });
    await user.click(await screen.findByRole("button", { name: "나중에" }));
    await screen.findByText("이 화면에서 기록한 의견: 나중에");
    expect(app.api.calls.filter((c) => c.key === "GET /me/recommendations")).toHaveLength(1);
    const write = app.api.spy.mock.calls.find(
      ([endpoint]) => String(endpoint.path) === "/me/recommendations/public-rec/feedback",
    );
    expect(write?.[1]).toMatchObject({ retryUnauthorized: false });
  });
  it("locks uncertain generation across tab remount without replaying it", async () => {
    const user = userEvent.setup();
    const app = setup("/me?tab=skills", {
      "GET /me/recommendations": (options) => {
        if ((options.query as { refresh?: boolean })?.refresh) throw apiFailure("server failure");
        return { user_id: runtime.id, recommendations: [] };
      },
    });
    await user.click(await screen.findByRole("button", { name: "추천 새로 계산" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "추천 새로 계산" })).toBeDisabled());
    await user.click(screen.getByRole("tab", { name: "요청·영수증" }));
    await user.click(screen.getByRole("tab", { name: "스킬·추천" }));
    await screen.findByText("public-skill");
    expect(screen.getByRole("button", { name: "추천 새로 계산" })).toBeDisabled();
    expect(
      app.api.calls.filter(
        (c) => c.key === "GET /me/recommendations" && (c.options.query as { refresh?: boolean })?.refresh,
      ),
    ).toHaveLength(1);
  });
  it("releases a confirmed pending write after tab remount", async () => {
    const user = userEvent.setup(),
      pending = deferred<unknown>();
    const app = setup("/me?tab=skills", {
      "GET /me/recommendations": (options) =>
        (options.query as { refresh?: boolean })?.refresh
          ? pending.promise
          : { user_id: runtime.id, recommendations: [] },
    });
    await user.click(await screen.findByRole("button", { name: "추천 새로 계산" }));
    await screen.findByRole("button", { name: "계산 중" });
    await user.click(screen.getByRole("tab", { name: "요청·영수증" }));
    await user.click(screen.getByRole("tab", { name: "스킬·추천" }));
    expect(screen.getByRole("button", { name: "계산 중" })).toBeDisabled();
    await act(async () => pending.resolve({ user_id: runtime.id, recommendations: [] }));
    await waitFor(() => expect(screen.getByRole("button", { name: "추천 새로 계산" })).toBeEnabled());
    expect(
      app.api.calls.filter(
        (c) => c.key === "GET /me/recommendations" && (c.options.query as { refresh?: boolean })?.refresh,
      ),
    ).toHaveLength(1);
  });
  it("restores request filters and search from the URL within the received list", async () => {
    const app = setup("/me?tab=requests&limit=50&request_status=error&requests_q=match", {
      "GET /me/requests": () => ({
        requests: [
          { id: "match-error", status_code: 500 },
          { id: "match-ok", status_code: 200 },
          { id: "another-error", status_code: 500 },
        ],
      }),
    });
    await screen.findByRole("link", { name: "match-error" });
    expect(screen.queryByRole("link", { name: "match-ok" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "another-error" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "내 최근 요청 검색어" })).toHaveValue("match");
    expect(app.api.calls.find((c) => c.key === "GET /me/requests")?.options.query).toEqual({ limit: 50 });
    await userEvent.setup().click(screen.getByRole("link", { name: "match-error" }));
    expect(screen.getByTestId("location")).toHaveTextContent("receipt=match-error");
    expect(screen.getByTestId("location")).toHaveTextContent("requests_q=match");
  });
});
