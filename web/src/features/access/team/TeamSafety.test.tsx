import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { endpoints } from "@/shared/api/endpoints";
import { mockApi, type ApiHandler } from "@/test/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { RouteQueryGuard } from "@/app/guards/RouteQueryGuard";
import { apiFailure } from "@/test/api";
import { tokenStore } from "@/shared/auth/token-store";
import { hiddenTeamText } from "./team-model";
import { TeamPage } from "./TeamPage";

const runtime = vi.hoisted(() => ({
  scopes: ["team:read", "admin:read"],
  team: "public-team",
  id: "public-user",
  readOnly: false,
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => ({
      ...testAuth({ scopes: runtime.scopes, user: { id: runtime.id, team_id: runtime.team } }),
      credentialPrefixes: ["public_credential_"],
    }),
  };
});
const notices = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const download = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: notices }));
vi.mock("@/shared/utils/csv", async (original) => ({ ...(await original<object>()), downloadCsv: download }));
const report = {
  id: "public-report",
  name: "공개 리포트",
  team: "public-team",
  approval_status: "pending",
  visibility: "private",
  question: "공개 질문",
  sql: "SELECT 1",
  revision: "a".repeat(64),
};
function Navigation() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate("/team?tab=portal")}>포털로 이동</button>
      <button onClick={() => navigate("/team")}>대시보드로 이동</button>
    </>
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(team = "public-team", route = "/team", extra: Record<string, ApiHandler> = {}) {
  const api = mockApi({
    "GET /team/dashboard": () => ({
      team_id: team,
      dashboard: { team_keys: [], totals: { requests: 7 }, top_users: [], models: [], recent_failures: [] },
    }),
    "GET /team/reports": () => ({ team_id: team, reports: [{ ...report, team }] }),
    "GET /team/portal": () => ({ team_id: team }),
    "POST /team/reports": () => ({ report_id: report.id, approval_status: "approved" }),
    "GET /team/savings-challenge": () => ({ team_id: team }),
    "GET /team/onboarding": () => ({ team_id: team, recommended_mcp: [] }),
    "GET /team/risk": () => ({ team_id: team, blocked: 0, blocked_trend: 0, recent_violations: [] }),
    "GET /team/skills/popular": () => ({ team_id: team, skills: [] }),
    "GET /team/templates/candidates": () => ({ team_id: team, candidates: [] }),
    ...extra,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route element={<RouteQueryGuard />}>
            <Route
              path="/team/*"
              element={
                <FeatureAccessContext.Provider
                  value={{
                    featureId: "team.home",
                    permitted: true,
                    readOnly: runtime.readOnly,
                    status: "preview",
                  }}
                >
                  <TeamPage />
                  <Navigation />
                </FeatureAccessContext.Provider>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, client, api, user: userEvent.setup(), update: () => view.rerender(tree()) };
}
beforeEach(() => {
  tokenStore.clearAll();
  vi.clearAllMocks();
  Object.assign(runtime, {
    scopes: ["team:read", "admin:read"],
    team: "public-team",
    id: "public-user",
    readOnly: false,
  });
});

describe("팀 조회 범위와 실제 응답 계약", () => {
  it("keeps a Korean team selection in the outgoing query", async () => {
    const view = setup("데이터 플랫폼", "/team?team=" + encodeURIComponent("데이터 플랫폼"));
    await waitFor(() => expect(view.api.calls.some((call) => call.key === "GET /team/dashboard")).toBe(true));
    expect(view.api.calls.find((call) => call.key === "GET /team/dashboard")?.options.query).toMatchObject({
      team: "데이터 플랫폼",
    });
  });
  it("does not load team data without team read permission", async () => {
    runtime.scopes = ["chat:completion"];
    const view = setup();
    await screen.findByText("팀 조회 권한이 없습니다.");
    expect(view.api.calls).toHaveLength(0);
  });
  it("uses the selected team for report decisions as well as reads", async () => {
    const view = setup("other", "/team?team=other", {
      "GET /team/reports": () => ({
        team_id: "other",
        reports: [
          {
            id: "public-report",
            name: "공개 리포트",
            team: "other",
            approval_status: "pending",
            visibility: "private",
            revision: "a".repeat(64),
          },
        ],
      }),
      "POST /team/reports": () => ({ report_id: "public-report", approval_status: "approved" }),
    });
    await screen.findByText("공개 리포트");
    await view.user.click(screen.getByRole("button", { name: "승인" }));
    const dialog = within(await screen.findByRole("dialog"));
    await view.user.type(dialog.getByLabelText(/변경 사유/u), "공개 검토 완료");
    await view.user.click(dialog.getByRole("button", { name: "승인" }));
    await waitFor(() => expect(view.api.bodies("POST /team/reports")).toHaveLength(1));
    expect(view.api.calls.find((call) => call.key === "POST /team/reports")?.options.query).toMatchObject({
      team: "other",
    });
  });
  it("accepts the numeric risk delta returned by the Go server", () => {
    expect(
      endpoints.domains.access.team.risk.schema.safeParse({ team_id: "public-team", blocked_trend: -2 })
        .success,
    ).toBe(true);
  });
  it("does not fabricate zero when a metric is missing", () => {
    const result = endpoints.domains.access.team.dashboard.schema.parse({
      team_id: "public-team",
      dashboard: { totals: {} },
    });
    expect(result.dashboard?.totals?.requests).toBeUndefined();
  });
});

async function review(view: ReturnType<typeof setup>) {
  await view.user.click(await screen.findByRole("button", { name: "승인" }));
  const dialog = within(await screen.findByRole("dialog", { name: "리포트 승인" }));
  await view.user.type(dialog.getByLabelText(/변경 사유/u), "공유 검토 완료");
  return dialog;
}
describe("팀 화면의 조회 수명과 승인 보호", () => {
  it.each([401, 403])(
    "retires the reader after a decision returns %s without automatic write retry",
    async (status) => {
      const view = setup("public-team", "/team", {
        "POST /team/reports": () => {
          throw apiFailure("private decision details", status);
        },
      });
      const dialog = await review(view);
      await view.user.click(dialog.getByRole("button", { name: "승인" }));
      await screen.findByText("팀 조회 권한이 없습니다.");
      expect(view.api.bodies("POST /team/reports")).toHaveLength(1);
      const call = view.api.spy.mock.calls.find(
        ([endpoint]) => endpoint.method === "POST" && endpoint.path === "/team/reports",
      );
      expect(call?.[1]).toMatchObject({ retryUnauthorized: false });
      expect(
        view.client
          .getQueryCache()
          .getAll()
          .filter((query) => query.queryKey.includes("team-home-read")),
      ).toHaveLength(0);
      expect(notices.success).not.toHaveBeenCalled();
    },
  );
  it("does not silently fall back to the own team after a sensitive URL selection is stripped", async () => {
    const view = setup("public-team", "/team?team=" + encodeURIComponent("corp secret=public-fixture"));
    await screen.findByText("팀 선택을 확인하세요.");
    expect(view.api.calls).toHaveLength(0);
    await view.user.click(screen.getByRole("button", { name: "팀 적용" }));
    await screen.findByText(report.name);
  });
  it("sends an actual 90-day duration and keeps risk fixed at seven days", async () => {
    const view = setup("public-team", "/team?window=90d");
    await screen.findByText(report.name);
    expect(view.api.calls.find((call) => call.key === "GET /team/dashboard")?.options.query).toMatchObject({
      window: "2160h",
    });
    expect(view.api.calls.find((call) => call.key === "GET /team/risk")?.options.query).toMatchObject({
      window: "7d",
    });
  });
  it("requires explicit team input in legacy/no-team mode", async () => {
    runtime.team = "";
    const view = setup();
    expect(await screen.findByText("배정된 팀이 없습니다.")).toBeVisible();
    expect(view.api.calls).toHaveLength(0);
  });
  it("rejects a different returned team before caching its contents", async () => {
    const view = setup("different");
    await waitFor(() =>
      expect(
        view.client
          .getQueryCache()
          .getAll()
          .some((query) => query.state.status === "error"),
      ).toBe(true),
    );
    expect(screen.queryByText("공개 리포트")).toBeNull();
    expect(
      view.client
        .getQueryCache()
        .getAll()
        .every((query) => query.state.data === undefined),
    ).toBe(true);
  });
  it("evicts all owned data after a forbidden response and needs explicit retry", async () => {
    let forbidden = false;
    const view = setup("public-team", "/team", {
      "GET /team/reports": () => {
        if (forbidden) throw apiFailure("private details", 403);
        return { team_id: "public-team", reports: [report] };
      },
    });
    await screen.findByText(report.name);
    forbidden = true;
    await view.user.click(screen.getByRole("button", { name: "새로고침" }));
    await screen.findByText("팀 조회 권한이 없습니다.");
    expect(screen.queryByText(report.name)).toBeNull();
    expect(
      view.client
        .getQueryCache()
        .getAll()
        .filter((query) => query.queryKey.includes("team-home-read")),
    ).toHaveLength(0);
    forbidden = false;
    await view.user.click(screen.getByRole("button", { name: "권한 확인 후 다시 조회" }));
    await screen.findByText(report.name);
  });
  it("keeps a reason draft but prevents decisions while readonly", async () => {
    const view = setup(),
      dialog = await review(view);
    runtime.readOnly = true;
    view.update();
    expect(dialog.getByLabelText(/변경 사유/u)).toHaveValue("공유 검토 완료");
    expect(dialog.getByRole("button", { name: "승인" })).toBeDisabled();
    runtime.readOnly = false;
    view.update();
    expect(dialog.getByRole("button", { name: "승인" })).toBeEnabled();
    expect(view.api.bodies("POST /team/reports")).toHaveLength(0);
  });
  it("restores focus to the same report trigger after cancelling", async () => {
    const view = setup();
    const trigger = await screen.findByRole("button", { name: "승인" });
    await view.user.click(trigger);
    await screen.findByRole("dialog");
    expect(trigger.isConnected).toBe(true);
    await view.user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });
  it("blocks a changed report revision before POST", async () => {
    let reads = 0;
    const view = setup("public-team", "/team", {
      "GET /team/reports": () => ({
        team_id: "public-team",
        reports: [{ ...report, revision: (++reads > 1 ? "b" : "a").repeat(64) }],
      }),
    });
    const dialog = await review(view);
    await view.user.click(dialog.getByRole("button", { name: "승인" }));
    await waitFor(() => expect(dialog.getByRole("alert")).toHaveTextContent("변경됐습니다"));
    expect(view.api.bodies("POST /team/reports")).toHaveLength(0);
  });
  it("does not write after the principal changes during latest-state review", async () => {
    const gate = deferred<unknown>();
    let reads = 0;
    const view = setup("public-team", "/team", {
      "GET /team/reports": () =>
        ++reads === 2 ? gate.promise : { team_id: "public-team", reports: [report] },
    });
    const dialog = await review(view);
    await view.user.click(dialog.getByRole("button", { name: "승인" }));
    await waitFor(() => expect(reads).toBe(2));
    runtime.id = "public-other";
    view.update();
    await act(async () => gate.resolve({ team_id: "public-team", reports: [report] }));
    expect(view.api.bodies("POST /team/reports")).toHaveLength(0);
    expect(notices.success).not.toHaveBeenCalled();
  });
  it("holds a pending write across tab remount and refreshes the current reports", async () => {
    const gate = deferred<unknown>();
    let decided = false;
    const view = setup("public-team", "/team", {
      "GET /team/reports": () => ({
        team_id: "public-team",
        reports: [
          { ...report, approval_status: decided ? "approved" : "pending" },
          ...(decided ? [{ ...report, id: "public-next", name: "다음 리포트" }] : []),
        ],
      }),
      "POST /team/reports": () => gate.promise,
    });
    const portalLink = screen.getByRole("button", { name: "포털로 이동" });
    const dialog = await review(view);
    await view.user.click(dialog.getByRole("button", { name: "승인" }));
    await waitFor(() => expect(view.api.bodies("POST /team/reports")).toHaveLength(1));
    // Simulate navigation outside the pending dialog, as a router/back action would.
    await act(async () => {
      portalLink.click();
    });
    await screen.findByRole("tab", { name: "팀 포털" });
    await view.user.click(screen.getByRole("button", { name: "대시보드로 이동" }));
    expect(await screen.findByRole("button", { name: "승인" })).toBeDisabled();
    decided = true;
    await act(async () => gate.resolve({ report_id: report.id, approval_status: "approved" }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("table", { name: "팀 공용 리포트" })).getByText("승인", {
          selector: ".badge",
        }),
      ).toBeVisible(),
    );
    expect(notices.success).not.toHaveBeenCalled();
    expect(view.api.bodies("POST /team/reports")).toHaveLength(1);
    await waitFor(() =>
      expect(
        within(screen.getByRole("row", { name: /다음 리포트/u })).getByRole("button", { name: "승인" }),
      ).toBeEnabled(),
    );
  });
  it("does not accept an acknowledgment for another report", async () => {
    const view = setup("public-team", "/team", {
      "POST /team/reports": () => ({ report_id: "other", approval_status: "approved" }),
    });
    const dialog = await review(view);
    await view.user.click(dialog.getByRole("button", { name: "승인" }));
    await waitFor(() => expect(dialog.getByRole("alert")).toHaveTextContent("처리 결과"));
    expect(notices.success).not.toHaveBeenCalled();
    await view.user.click(dialog.getByRole("button", { name: "취소" }));
    expect(screen.getByRole("button", { name: "승인" })).toBeDisabled();
  });
  it("masks credentials and strips unrelated fields before query caching and CSV", async () => {
    const secret = "public_credential_abcdefghijklmnopqrstuvwxyzABCDEF";
    const view = setup("public-team", "/team", {
      "GET /team/reports": () => ({
        team_id: "public-team",
        secret,
        reports: [{ ...report, name: "=1+1", question: secret, sql: secret, unknown_payload: secret }],
      }),
    });
    await screen.findByText("=1+1");
    const cached = JSON.stringify(
      view.client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    );
    expect(cached).not.toContain(secret);
    expect(cached).not.toContain("unknown_payload");
    const section = screen.getByRole("table", { name: "팀 공용 리포트" }).closest(".team-table");
    if (!section) throw new Error("table section missing");
    await view.user.click(within(section as HTMLElement).getByRole("button", { name: "검색 결과 CSV" }));
    expect(download).toHaveBeenCalledTimes(1);
    expect(String(download.mock.calls[0]?.[1])).toContain("'=1+1");
    expect(String(download.mock.calls[0]?.[1])).not.toContain(hiddenTeamText);
    const dialog = await review(view);
    expect(dialog.getByLabelText("리포트 질문")).toHaveTextContent(hiddenTeamText);
  });
  it("keeps healthy widgets and hides unavailable risk metrics", async () => {
    setup("public-team", "/team", {
      "GET /team/risk": () => ({
        team_id: "public-team",
        blocked: 0,
        warned: 0,
        partial_failures: ["policy_current"],
        secrets_total: 5,
      }),
    });
    await screen.findByText("일부 항목을 확인하지 못했습니다.");
    expect(screen.getByText(report.name)).toBeVisible();
    expect(screen.getByText("이전 7일 대비 변화 미확인")).toBeVisible();
  });
});
