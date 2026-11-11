import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FeatureAccessContext } from "@/shared/feature-access/context";
import { TeamPage } from "@/features/access/team/TeamPage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ scopes: ["team:read"] as string[] }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({ role: "team_manager", scopes: authRuntime.scopes, user: { team_id: "platform" } }),
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const dashboard = {
  team_id: "platform",
  since: "2026-08-08T00:00:00Z",
  dashboard: {
    team_keys: ["key_a", "key_b"],
    totals: {
      requests: 5400,
      tokens: 1_200_000,
      cost_krw: 320_000,
      errors: 42,
      avg_latency_ms: 510,
      success_rate: 0.99,
    },
    top_users: [{ user_id: "usr_alpha", requests: 2400, cost_krw: 140_000, errors: 8 }],
    models: [{ model: "gpt-4o", requests: 3000, cost_krw: 220_000 }],
    recent_failures: [
      {
        id: "req_9",
        model: "gpt-4o",
        status_code: 500,
        error: "upstream error",
        created_at: "2026-09-06T02:00:00Z",
      },
    ],
  },
};

const emptyExtras = {
  "GET /team/reports": () => ({ team_id: "platform", reports: [] }),
  "GET /team/savings-challenge": () => ({ team_id: "platform", month_to_date_krw: 100 }),
  "GET /team/onboarding": () => ({ team_id: "platform", recommended_mcp: [] }),
  "GET /team/risk": () => ({ team_id: "platform", blocked: 0, warned: 0, recent_violations: [] }),
  "GET /team/skills/popular": () => ({ team_id: "platform", skills: [] }),
  "GET /team/templates/candidates": () => ({ team_id: "platform", candidates: [] }),
};

function handlers(overrides: Record<string, () => unknown> = {}) {
  return {
    "GET /team/dashboard": () => dashboard,
    ...emptyExtras,
    ...overrides,
  };
}

const pendingReports = {
  team_id: "platform",
  reports: [
    {
      id: "rep_1",
      name: "주간 비용",
      question: "",
      sql: "",
      schema_name: "analytics",
      kind: "text2sql",
      created_by: "usr_alpha",
      created_at: "2026-09-01T00:00:00Z",
      schedule_interval: "",
      schedule_enabled: false,
      deliver_mattermost: false,
      last_run_at: "",
      team: "platform",
      visibility: "team",
      revision: "a".repeat(64),
      approval_status: "pending",
      approved_by: "",
      approved_at: "",
    },
    {
      id: "rep_2",
      name: "이미 승인된 리포트",
      question: "",
      sql: "",
      schema_name: "analytics",
      kind: "text2sql",
      created_by: "usr_beta",
      created_at: "2026-08-01T00:00:00Z",
      schedule_interval: "",
      schedule_enabled: false,
      deliver_mattermost: false,
      last_run_at: "",
      team: "platform",
      visibility: "team",
      revision: "a".repeat(64),
      approval_status: "approved",
      approved_by: "usr_lead",
      approved_at: "2026-08-02T00:00:00Z",
    },
  ],
};

describe("TeamPage", () => {
  beforeEach(() => {
    authRuntime.scopes = ["team:read"];
  });

  it("renders the team dashboard totals", async () => {
    mockApi(handlers());
    renderScreen(
      <FeatureAccessContext.Provider
        value={{ featureId: "team.home", permitted: true, readOnly: false, status: "preview" }}
      >
        <TeamPage />
      </FeatureAccessContext.Provider>,
      { path: "/team/*", route: "/team" },
    );

    expect(await screen.findByText("usr_alpha")).toBeVisible();
    expect(screen.getByText("upstream error")).toBeVisible();
    expect(screen.getByText("₩320,000")).toBeVisible();
  });

  it("shows empty states for the async team cards", async () => {
    mockApi(handlers());
    renderScreen(
      <FeatureAccessContext.Provider
        value={{ featureId: "team.home", permitted: true, readOnly: false, status: "preview" }}
      >
        <TeamPage />
      </FeatureAccessContext.Provider>,
      { path: "/team/*", route: "/team" },
    );

    expect(await screen.findAllByText("아직 기록된 항목이 없습니다.")).not.toHaveLength(0);
    expect(screen.getByRole("table", { name: "팀 공용 리포트" })).toHaveTextContent(
      "아직 기록된 항목이 없습니다.",
    );
  });

  it("surfaces the request id when the dashboard fails", async () => {
    mockApi(
      handlers({
        "GET /team/dashboard": () => {
          throw apiFailure("boom", 500, "req_team_1");
        },
      }),
    );
    renderScreen(
      <FeatureAccessContext.Provider
        value={{ featureId: "team.home", permitted: true, readOnly: false, status: "preview" }}
      >
        <TeamPage />
      </FeatureAccessContext.Provider>,
      { path: "/team/*", route: "/team" },
    );

    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((node) => node.textContent?.includes("req_team_1"))).toBe(true);
  });

  it("warns when the caller has no team:read scope", async () => {
    authRuntime.scopes = ["chat:completion"];
    mockApi(handlers());
    renderScreen(
      <FeatureAccessContext.Provider
        value={{ featureId: "team.home", permitted: true, readOnly: false, status: "preview" }}
      >
        <TeamPage />
      </FeatureAccessContext.Provider>,
      { path: "/team/*", route: "/team" },
    );

    expect(await screen.findByText("팀 조회 권한이 없습니다.")).toBeVisible();
    expect(screen.queryByLabelText("팀")).toBeNull();
  });

  it("passes ?team= through only for operators with admin:read", async () => {
    authRuntime.scopes = ["team:read", "admin:read"];
    const api = mockApi(handlers());
    renderScreen(
      <FeatureAccessContext.Provider
        value={{ featureId: "team.home", permitted: true, readOnly: false, status: "preview" }}
      >
        <TeamPage />
      </FeatureAccessContext.Provider>,
      { path: "/team/*", route: "/team?team=platform" },
    );

    await screen.findByText("usr_alpha");
    expect(api.calls.find((call) => call.key === "GET /team/dashboard")?.options.query).toEqual({
      window: "30d",
      team: "platform",
    });
    expect(screen.getByLabelText("팀")).toHaveValue("platform");
  });

  it("restores the portal tab from the URL", async () => {
    const user = userEvent.setup();
    mockApi({
      ...handlers(),
      "GET /team/portal": () => ({
        team_id: "platform",
        usage: { requests: 5400, cost_krw: 320_000, success_rate: 0.99 },
        budgets: [],
        api_keys: [{ id: "key_a", name: "빌드", status: "active" }],
        api_key_count: 1,
        members: ["carol", "alice"],
        member_count: 2,
        accessible_skills: [],
        skill_count: 0,
        pending_skill_requests: [],
      }),
    });
    renderScreen(
      <FeatureAccessContext.Provider
        value={{ featureId: "team.home", permitted: true, readOnly: false, status: "preview" }}
      >
        <TeamPage />
      </FeatureAccessContext.Provider>,
      { path: "/team/*", route: "/team?tab=portal" },
    );

    expect(await screen.findByText("빌드")).toBeVisible();
    expect(screen.getByRole("tab", { name: "팀 포털" })).toHaveAttribute("aria-selected", "true");

    const members = screen.getAllByText(/alice|carol/u);
    expect(members[0]).toHaveTextContent("alice");
    await user.click(screen.getByRole("tab", { name: "팀 대시보드" }));
    expect(await screen.findByText("usr_alpha")).toBeVisible();
  });

  it("approves a pending team report", async () => {
    const user = userEvent.setup();
    const api = mockApi(
      handlers({
        "GET /team/reports": () => pendingReports,
        "POST /team/reports": () => ({ report_id: "rep_1", approval_status: "approved" }),
      }),
    );
    renderScreen(
      <FeatureAccessContext.Provider
        value={{ featureId: "team.home", permitted: true, readOnly: false, status: "preview" }}
      >
        <TeamPage />
      </FeatureAccessContext.Provider>,
      { path: "/team/*", route: "/team" },
    );

    await screen.findByText("주간 비용");
    const [pendingApprove, decidedApprove] = screen.getAllByRole("button", { name: "승인" });
    expect(decidedApprove).toBeDisabled();
    await user.click(pendingApprove as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/변경 사유/u), "검토 완료");
    await user.click(within(dialog).getByRole("button", { name: "승인" }));

    await waitFor(() => {
      expect(api.bodies("POST /team/reports")).toEqual([
        { report_id: "rep_1", action: "approve", reason: "검토 완료" },
      ]);
    });
  });

  it("rejects a pending team report", async () => {
    const user = userEvent.setup();
    const api = mockApi(
      handlers({
        "GET /team/reports": () => pendingReports,
        "POST /team/reports": () => ({ report_id: "rep_1", approval_status: "rejected" }),
      }),
    );
    renderScreen(
      <FeatureAccessContext.Provider
        value={{ featureId: "team.home", permitted: true, readOnly: false, status: "preview" }}
      >
        <TeamPage />
      </FeatureAccessContext.Provider>,
      { path: "/team/*", route: "/team" },
    );

    await screen.findByText("주간 비용");
    const [pendingReject] = screen.getAllByRole("button", { name: "반려" });
    await user.click(pendingReject as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/변경 사유/u), "검토 완료");
    await user.click(within(dialog).getByRole("button", { name: "반려" }));

    await waitFor(() => {
      expect(api.bodies("POST /team/reports")).toEqual([
        { report_id: "rep_1", action: "reject", reason: "검토 완료" },
      ]);
    });
  });

  it("has no automated accessibility violations", async () => {
    mockApi(handlers());
    const { container } = renderScreen(
      <FeatureAccessContext.Provider
        value={{ featureId: "team.home", permitted: true, readOnly: false, status: "preview" }}
      >
        <TeamPage />
      </FeatureAccessContext.Provider>,
      { path: "/team/*", route: "/team" },
    );

    await screen.findByText("usr_alpha");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
