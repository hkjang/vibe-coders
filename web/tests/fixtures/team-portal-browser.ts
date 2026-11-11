import { expect, type Page } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

export const teamReport = {
  id: "public-team-report",
  name: "주간 운영 보고서",
  question: "지난주 모델별 요청 수를 알려 주세요.",
  sql: "SELECT model, COUNT(*) AS requests FROM public_requests GROUP BY model",
  schema_name: "public_analytics",
  kind: "report",
  created_by: "공개 작성자",
  created_at: "2030-01-02T00:00:00Z",
  last_run_at: "",
  schedule_interval: "24h",
  schedule_enabled: true,
  deliver_mattermost: false,
  visibility: "private",
  approval_status: "pending",
  revision: "a".repeat(64),
  approved_by: "",
  approved_at: "",
};
export async function installTeamPortal(page: Page, readOnly = false) {
  const user = {
    id: "public-team-operator",
    name: "공개 운영자",
    email: "public@example.invalid",
    role: "admin",
    roles: ["admin"],
    team_id: "public-team",
    scopes: ["team:read", "admin:read"],
  };
  const bootstrap: UiBootstrapResponse = {
    backend_version: "v0.86.70",
    ui_version: "public-team-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/team",
      legacy_fallback: true,
      feedback_enabled: false,
      telemetry_enabled: false,
    },
    authentication: {
      enabled: false,
      authenticated: true,
      mode: "open",
      keycloak_enabled: false,
      allow_local_login: true,
      sso_login_url: "/auth/keycloak/login",
      credential_prefixes: ["corp_"],
    },
    user,
    roles: user.roles,
    permissions: user.scopes,
    capabilities: { raw_prompt_view: false },
    allowed_features: ["team.home"],
    migration_registry: [
      {
        feature_id: "team.home",
        title: "팀 대시보드",
        app_path: "/app/team",
        legacy_path: "/admin#/team",
        status: "preview",
        risk_level: "medium",
        required_permission: "team:read",
        read_only: readOnly,
        enabled_roles: [],
        rollout_percent: 100,
        fallback_enabled: true,
        minimum_api_version: "v0.82.0",
        available: true,
      },
    ],
    system_status: { status: "healthy" },
    legacy_route_map: {},
  };
  const state = { reports: [structuredClone(teamReport)], dashboardStatus: 200, lost: false, wrong: false };
  const writes: { path: string; team: string; body: unknown }[] = [];
  const reads: { path: string; team: string; window: string }[] = [];
  const unexpected: string[] = [],
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.name));
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      method = request.method();
    if (path.startsWith("/app/")) return route.continue();
    const json = (body: unknown, status = 200) => route.fulfill({ json: body, status });
    if (path === "/auth/me") return json({ authenticated: true, user });
    if (path === "/admin/ui-bootstrap") return json(bootstrap);
    if (path === "/health") return json({ status: "ok" });
    const team = url.searchParams.get("team") || user.team_id;
    if (method === "GET" && path.startsWith("/team/")) {
      reads.push({ path, team, window: url.searchParams.get("window") ?? "" });
      const base = { team_id: team, since: "2030-01-01T00:00:00Z", partial_failures: [] };
      if (path === "/team/dashboard") {
        if (state.dashboardStatus !== 200)
          return json({ error: { message: "public failure" } }, state.dashboardStatus);
        return json({
          ...base,
          dashboard: {
            team_keys: [team],
            totals: {
              requests: 1280,
              errors: 12,
              tokens: 420000,
              cost_krw: 48200,
              success_rate: 0.990625,
              avg_latency_ms: 840,
            },
            top_users: [{ user_id: "공개 팀원", requests: 820, errors: 8, cost_krw: 32100 }],
            models: [{ model: "public-balanced", requests: 1280, cost_krw: 48200 }],
            recent_failures: [
              {
                id: "public-request",
                model: "public-balanced",
                status_code: 502,
                error: "공개 공급자 연결 지연",
                created_at: "2030-01-02T00:00:00Z",
              },
            ],
          },
        });
      }
      if (path === "/team/reports")
        return json({ ...base, reports: state.reports.map((row) => ({ ...row, team })) });
      if (path === "/team/savings-challenge")
        return json({
          ...base,
          month_to_date_krw: 48200,
          projected_month_end_krw: 96000,
          last_month_krw: 110000,
          projected_savings_krw: 14000,
          on_track: true,
        });
      if (path === "/team/risk")
        return json({
          ...base,
          blocked: 2,
          warned: 3,
          blocked_trend: -2,
          secrets_total: 1,
          pending_approvals: 1,
          recent_violations: [],
        });
      const skill = {
        skill_name: "공개 문서 요약",
        runs: 24,
        success_rate: 0.96,
        total_cost_krw: 480,
        avg_latency_ms: 920,
      };
      if (path === "/team/skills/popular") return json({ ...base, skills: [skill] });
      if (path === "/team/onboarding")
        return json({
          ...base,
          recommended_models: [{ model: "public-balanced", requests: 1280, cost_krw: 48200 }],
          recommended_skills: [skill],
          recommended_mcp: [
            {
              server_label: "공개 검색 서버",
              tool_name: "문서 검색",
              ref: "public-search",
              calls: 48,
              success_rate: 0.98,
              avg_latency_ms: 120,
            },
          ],
        });
      if (path === "/team/templates/candidates")
        return json({
          ...base,
          candidates: [
            {
              fingerprint: "public-fingerprint",
              task_type: "문서 요약",
              requests: 12,
              avg_cost_krw: 24,
              success_rate: 1,
              already_product: false,
            },
          ],
        });
      if (path === "/team/portal")
        return json({
          ...base,
          usage: { requests: 1280, success_rate: 0.99, cost_krw: 48200, avg_latency_ms: 840 },
          budgets: [
            {
              monthly_krw: 200000,
              spent_krw: 48200,
              burn_ratio: 0.241,
              projected_krw: 96000,
              on_track: true,
            },
          ],
          api_keys: [
            {
              id: "public-build-key",
              name: "공개 빌드 키",
              owner: "공개 팀원",
              status: "active",
              expires_at: "2030-12-31T00:00:00Z",
              budget_limit_krw: 100000,
            },
          ],
          api_key_count: 1,
          members: ["공개 팀원"],
          member_count: 1,
          accessible_skills: [
            {
              name: "공개 문서 요약",
              version: "1.0",
              description: "문서의 핵심을 요약합니다.",
              risk_level: "low",
            },
          ],
          skill_count: 1,
          pending_skill_requests: [
            {
              id: "public-access",
              skill_name: "공개 분석 도우미",
              user_id: "공개 팀원",
              reason: "업무 분석",
              created_at: "2030-01-02T00:00:00Z",
            },
          ],
        });
    }
    if (method === "POST" && path === "/team/reports") {
      const body = request.postDataJSON() as { report_id: string; action: string };
      writes.push({ path, team, body });
      if (state.lost) return route.abort("failed");
      if (state.wrong) return json({ report_id: "wrong", approval_status: "approved" });
      const row = state.reports.find((item) => item.id === body.report_id);
      if (!row) return json({ error: { message: "missing" } }, 404);
      row.approval_status = body.action === "approve" ? "approved" : "rejected";
      return json({ report_id: row.id, approval_status: row.approval_status });
    }
    unexpected.push(method + " " + path);
    return json({ error: { message: "unexpected fixture request" } }, 500);
  });
  return {
    state,
    writes,
    reads,
    check: () => {
      expect(unexpected).toEqual([]);
      expect(errors).toEqual([]);
    },
  };
}
