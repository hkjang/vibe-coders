import { expect, type Page } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

const created = "2030-01-02T00:00:00Z";
export const personalSkill = {
  name: "공개 문서 요약",
  description: "문서의 핵심을 요약합니다.",
  risk_level: "low",
  runs_30d: 100,
  users_30d: 4,
  success_rate: 1,
  satisfaction: 4.3,
  feedback_count: 8,
};
export const personalRequest = {
  id: "public-request",
  model: "public-balanced",
  provider: "공개 공급자",
  endpoint: "/v1/chat/completions",
  status_code: 200,
  cost_krw: 24,
  total_tokens: 1200,
  cached: true,
  created_at: created,
};
export async function installPersonalConsole(page: Page, readOnly = false) {
  const user = {
    id: "public-person",
    name: "공개 사용자",
    email: "person@example.invalid",
    role: "developer",
    roles: ["developer"],
    team_id: "public-team",
    scopes: ["chat:completion"],
  };
  const bootstrap: UiBootstrapResponse = {
    backend_version: "v0.86.71",
    ui_version: "public-personal-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/me",
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
    allowed_features: ["me.home"],
    migration_registry: [
      {
        feature_id: "me.home",
        title: "내 홈",
        app_path: "/app/me",
        legacy_path: "/admin#/me",
        status: "preview",
        risk_level: "medium",
        required_permission: "",
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
  const recommendation = {
    id: "public-rec",
    user_id: user.id,
    kind: "template",
    title: "공개 문서 요약 템플릿",
    detail: "반복하는 요약 작업에 템플릿을 활용하세요.",
    est_savings_krw: 800,
    created_at: created,
  };
  const state = {
    requests: [personalRequest],
    dashboardStatus: 200,
    wrong: false,
    failGeneration: false,
    partial: false,
    recommendations: [recommendation],
  };
  const reads: { path: string; refresh: string | null; limit: string | null; window: string | null }[] = [];
  const writes: { path: string; body: unknown }[] = [];
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
    const base = { user_id: user.id, partial_failures: [] };
    if (method === "GET" && path.startsWith("/me/")) {
      reads.push({
        path,
        refresh: url.searchParams.get("refresh"),
        limit: url.searchParams.get("limit"),
        window: url.searchParams.get("window"),
      });
      if (path === "/me/dashboard") {
        if (state.dashboardStatus !== 200)
          return json({ error: { message: "public failure" } }, state.dashboardStatus);
        return json({
          ...base,
          today: { requests: 48, tokens: 36000, cost_krw: 1200, errors: 1 },
          month: { requests: 1280, tokens: 840000, cost_krw: 48200, errors: 12 },
          profile: {
            success_rate: 0.990625,
            risk_score: 12,
            summary: "사용이 안정적입니다. 캐시 적중과 모델 선택으로 비용을 줄일 수 있습니다.",
          },
          potential_savings_krw: 6400,
          potential_savings_model: "public-fast",
          frequent_models: [
            { model: "public-balanced", requests: 1280, avg_cost_krw: 37.65, success_rate: 0.990625 },
          ],
          recent_failures: [
            {
              id: "public-failure",
              model: "public-balanced",
              status_code: 502,
              error: "공개 공급자 연결 지연",
              task_type: "요약",
              created_at: created,
            },
          ],
          key_alerts: [
            {
              id: "public-key",
              name: "공개 개발 키",
              user_id: user.id,
              flags: ["expiring_soon"],
              severity: "warn",
              expires_at: "2030-01-08T00:00:00Z",
            },
          ],
          recent_blocks: [],
          my_saved_reports: [
            {
              id: "public-report",
              name: "주간 사용량",
              kind: "report",
              visibility: "private",
              approval_status: "pending",
              created_at: created,
            },
          ],
          recommended_templates: [
            {
              id: "public-template",
              name: "문서 요약",
              category: "요약",
              description: "핵심 내용과 다음 행동을 정리합니다.",
            },
          ],
          recent_prompt_products: [],
        });
      }
      if (path === "/me/actions")
        return json({
          ...base,
          count: 1,
          actions: [
            {
              type: "key_expiry",
              severity: "high",
              message: "곧 만료되는 API 키가 있습니다.",
              button_label: "키 확인",
            },
          ],
        });
      if (path === "/me/notifications")
        return json({
          ...base,
          count: 1,
          critical_count: 0,
          notifications: [
            {
              category: "recommendation",
              level: "info",
              title: "새 추천을 확인하세요.",
              detail: "모델과 템플릿을 검토할 수 있습니다.",
              created_at: created,
            },
          ],
        });
      if (path === "/me/report")
        return json({
          ...base,
          window: url.searchParams.get("window") ?? "weekly",
          since: "2030-01-01T00:00:00Z",
          requests: 320,
          tokens: 210000,
          cost_krw: 12000,
          prior_cost_krw: 15000,
          errors: 2,
          success_rate: 0.99375,
          cache_rate: 0.31,
          cost_delta_ratio: -0.2,
        });
      if (path === "/me/requests") return json({ requests: state.requests });
      if (/^\/me\/requests\/[^/]+\/receipt$/u.test(path))
        return json({
          request_id: state.wrong ? "other-request" : decodeURIComponent(path.split("/")[3] ?? ""),
          created_at: created,
          model: "public-balanced",
          provider: "공개 공급자",
          endpoint: "/v1/chat/completions",
          status_code: 200,
          latency_ms: 420,
          tokens: { prompt: 900, completion: 300, total: 1200, cached: 600 },
          cost_krw: 24,
          cache_hit: true,
          blocked: false,
          policy: [],
          mcp_used: true,
          mcp_tools: [{ server: "공개 검색 서버", tool: "문서 검색", error: false }],
          skill_used: false,
          skills: [],
          routing: {
            requested_model: "auto",
            selected_model: "public-balanced",
            selected_provider: "공개 공급자",
            reason: "품질과 비용을 고려한 기본 선택",
            fallback_path: ["public-fast"],
            risk_tier: "low",
            complexity_tier: "medium",
          },
        });
      if (path === "/me/recommended-models")
        return json({
          task_recommendations: [
            { task_type: "문서 요약", requests: 48, recommend: ["public-fast"], avoid: [] },
          ],
          your_models: [
            {
              model: "public-balanced",
              requests: 1280,
              tags: { good_for: "요약, 분석", avoid_for: "", risk_note: "중요 결과는 검토하세요." },
            },
          ],
          team_winners: [{ model: "public-balanced", wins: 8, avg_score: 4.3, appearances: 10 }],
        });
      if (path === "/me/skills")
        return json({
          team: user.team_id,
          available: [personalSkill],
          requestable: [
            {
              ...personalSkill,
              name: "공개 분석 도우미",
              description: "승인을 받은 뒤 데이터 분석을 지원합니다.",
              risk_level: "medium",
            },
          ],
          partial_failures: state.partial ? ["runs"] : [],
        });
      if (path === "/me/recommendations") {
        if (url.searchParams.get("refresh") === "true" && state.failGeneration)
          return json({ error: { message: "public failure" } }, 500);
        return json({ ...base, recommendations: state.recommendations });
      }
    }
    if (method === "POST" && path.startsWith("/me/")) {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ path, body });
      if (path === "/me/actions/snooze")
        return json({ type: body.type, snoozed_until: "2030-01-09T00:00:00Z" });
      if (path === "/me/recommendations/public-rec/feedback")
        return json({ status: "recorded", kind: "template", action: body.action });
      if (path.startsWith("/me/skills/"))
        return json(
          {
            status: path.endsWith("request-access") ? "requested" : "recorded",
            skill: state.wrong ? "other-skill" : decodeURIComponent(path.split("/")[3] ?? ""),
          },
          201,
        );
    }
    unexpected.push(method + " " + path);
    return json({ error: { message: "unexpected fixture request" } }, 500);
  });
  return {
    state,
    reads,
    writes,
    check: () => {
      expect(unexpected).toEqual([]);
      expect(errors).toEqual([]);
    },
  };
}
