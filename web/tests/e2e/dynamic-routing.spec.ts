import { expect, test, type Page } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// Synthetic responses only: this proves the screens, not the server's graph checks.
const feature = (feature_id: string, app_path: string, title: string) => ({
  feature_id,
  title,
  app_path,
  legacy_path: "/admin#/routing",
  status: "preview",
  risk_level: "high",
  required_permission: "routing:read",
  read_only: false,
  enabled_roles: [] as string[],
  rollout_percent: 100,
  fallback_enabled: false,
  minimum_api_version: "v0.84.0",
  available: true,
});

const route = {
  id: "drt_support",
  name: "support",
  description: "고객 지원 챗봇 경로",
  enabled: true,
  deployed_version: 1,
  latest_version: 1,
  deployed_at: "2026-11-24T00:00:00Z",
  deployed_by: "ops",
  created_by: "ops",
  updated_by: "ops",
  created_at: "2026-11-20T00:00:00Z",
  updated_at: "2026-11-24T00:00:00Z",
  call_model: "dynamic/support",
  state: "live",
  traffic_24h: { requests: 420, failures: 3, fallbacks: 12 },
};

const graph = {
  elements: [
    { id: "start", type: "start", properties: {}, outputs: { next: { elementId: "plan" } } },
    {
      id: "plan",
      type: "conditional",
      label: "요금제 확인",
      properties: { conditions: { "metadata.plan": { $eq: "free" } } },
      outputs: { true: { elementId: "budget" }, false: { elementId: "premium" } },
    },
    {
      id: "budget",
      type: "rate",
      properties: { limitType: "cost", key: "metadata.user_id", limit: 5000, window: 86400 },
      outputs: { success: { elementId: "split" }, fallback: { elementId: "light" } },
    },
    {
      id: "split",
      type: "percentage",
      properties: { stickyKey: "metadata.user_id" },
      outputs: { "90%": { elementId: "light" }, "10%": { elementId: "premium" } },
    },
    {
      id: "premium",
      type: "model",
      properties: { model: "gpt-4.1", provider: "openai", timeout: 30000, retries: 1 },
      outputs: { success: { elementId: "end" }, fallback: { elementId: "light" } },
    },
    {
      id: "light",
      type: "model",
      properties: { model: "gpt-4.1-mini" },
      outputs: { success: { elementId: "end" } },
    },
    { id: "end", type: "end", properties: {} },
  ],
};

interface Gateway {
  saves: unknown[];
  simulations: unknown[];
  activityQueries: string[];
}

async function install(page: Page): Promise<Gateway> {
  const gateway: Gateway = { saves: [], simulations: [], activityQueries: [] };
  const user = {
    id: "routing-operator",
    email: "router@example.invalid",
    name: "라우팅 검증",
    role: "admin",
    roles: ["admin"],
    team_id: "",
    scopes: ["routing:read", "routing:write", "admin:read"],
  };
  const bootstrap: UiBootstrapResponse = {
    backend_version: "v0.86.174",
    ui_version: "dynamic-routing-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/routing/dynamic",
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
    },
    user,
    roles: user.roles,
    permissions: user.scopes,
    capabilities: { raw_prompt_view: false },
    allowed_features: ["routing.dynamic"],
    migration_registry: [feature("routing.dynamic", "/app/routing/dynamic", "동적 라우팅")],
    system_status: { status: "healthy" },
    legacy_route_map: {},
  } as UiBootstrapResponse;
  const detail = {
    route,
    versions: [
      {
        route_id: route.id,
        version: 1,
        note: "처음 배포",
        created_by: "ops",
        created_at: "2026-11-20T00:00:00Z",
      },
    ],
    latest: {
      route_id: route.id,
      version: 1,
      note: "처음 배포",
      created_by: "ops",
      created_at: "2026-11-20T00:00:00Z",
      graph,
    },
    fields: [{ field: "identity.team", description: "호출 키의 팀 이름" }],
  };
  await page.route("**/*", async (intercepted) => {
    const request = intercepted.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/app/")) return intercepted.continue();
    const path = url.pathname;
    if (path === "/admin/ui-bootstrap") return intercepted.fulfill({ json: bootstrap });
    if (path === "/auth/me") return intercepted.fulfill({ json: user });
    if (path === "/health") return intercepted.fulfill({ json: { status: "ok" } });
    if (path === "/admin/routing/dynamic-routes" && request.method() === "GET")
      return intercepted.fulfill({ json: { routes: [route], count: 1, fields: detail.fields } });
    if (path === "/admin/routing/dynamic-routes/validate")
      return intercepted.fulfill({
        json: { valid: true, graph: request.postDataJSON().graph, validation: { errors: [], warnings: [] } },
      });
    if (path === "/admin/routing/dynamic-routes/simulate") {
      gateway.simulations.push(request.postDataJSON());
      return intercepted.fulfill({
        json: {
          result: {
            steps: [
              { id: "start", type: "start", outcome: "next" },
              { id: "plan", type: "conditional", outcome: "false" },
              { id: "premium", type: "model", outcome: "failed", detail: "simulated" },
              { id: "light", type: "model", outcome: "success" },
              { id: "end", type: "end", outcome: "end" },
            ],
            path: "start>plan:false>premium:failed>light:success>end",
            outcome: "success",
            final_element_id: "light",
            final_model: "gpt-4.1-mini",
            provider: "",
            attempts: 2,
            fallbacks: 1,
          },
          distribution: [
            {
              final_element_id: "light",
              final_model: "gpt-4.1-mini",
              outcome: "success",
              count: 900,
              share: 0.9,
            },
            {
              final_element_id: "premium",
              final_model: "gpt-4.1",
              outcome: "success",
              count: 100,
              share: 0.1,
            },
          ],
          samples: 1000,
          validation: { errors: [], warnings: [] },
        },
      });
    }
    if (path === `/admin/routing/dynamic-routes/${route.id}`) return intercepted.fulfill({ json: detail });
    if (path === `/admin/routing/dynamic-routes/${route.id}/versions`) {
      gateway.saves.push(request.postDataJSON());
      return intercepted.fulfill({
        status: 201,
        json: {
          route: { ...route, latest_version: 2, state: "live_with_draft" },
          validation: { errors: [], warnings: [] },
        },
      });
    }
    if (path === `/admin/routing/dynamic-routes/${route.id}/activity`) {
      gateway.activityQueries.push(url.search);
      return intercepted.fulfill({
        json: {
          route,
          hours: Number(url.searchParams.get("hours") ?? 24),
          traffic: [
            {
              version: 1,
              final_element_id: "light",
              final_model: "gpt-4.1-mini",
              outcome: "success",
              requests: 30,
              fallbacks: 4,
              avg_latency_ms: 410,
              cost_krw: 12.5,
            },
            {
              version: 1,
              final_element_id: "",
              final_model: "",
              outcome: "rate_limited",
              requests: 2,
              fallbacks: 0,
              avg_latency_ms: 0,
              cost_krw: 0,
            },
          ],
          limits: [
            {
              element_id: "budget",
              scoped: true,
              window_start: "2026-11-25T00:00:00Z",
              window_end: "2026-11-26T00:00:00Z",
              request_count: 0,
              cost_krw: 4200,
            },
          ],
          requests: [
            {
              request_id: "req-1",
              route_id: route.id,
              route_name: route.name,
              version: 1,
              final_element_id: "light",
              final_model: "gpt-4.1-mini",
              final_provider: "openai",
              fallbacks: 1,
              attempts: 2,
              outcome: "success",
              status_code: 200,
              latency_ms: 512,
              cost_krw: 0.4,
              created_at: "2026-11-25T05:00:00Z",
              steps: [
                { id: "start", type: "start", outcome: "next" },
                { id: "plan", type: "conditional", outcome: "false" },
                { id: "premium", type: "model", outcome: "failed", detail: "5xx" },
                { id: "light", type: "model", outcome: "success" },
                { id: "end", type: "end", outcome: "end" },
              ],
              metadata: { plan: "pro", user_id: "[REDACTED_EMAIL]" },
            },
          ],
        },
      });
    }
    return intercepted.fulfill({
      status: 404,
      json: { error: { message: "not mocked", type: "invalid_request_error", code: "not_found" } },
    });
  });
  return gateway;
}

test("lists routes, edits a model element and saves a version on the loaded base", async ({ page }) => {
  const gateway = await install(page);
  await page.goto("routing/dynamic");
  await expect(page.getByRole("heading", { name: "동적 라우팅" })).toBeVisible();
  await page.getByRole("link", { name: "support", exact: true }).click();

  const flow = page.getByRole("group", { name: /support 경로 흐름/u });
  await expect(flow.getByRole("button")).toHaveCount(graph.elements.length);
  await flow.getByRole("button", { name: /모델 premium/u }).click();
  await page.getByRole("textbox", { name: "모델" }).fill("gpt-4.1-2026");
  await expect(page.getByText("오류가 없습니다", { exact: false })).toBeVisible();
  await page.getByRole("textbox", { name: "변경 메모" }).fill("기본 모델 교체");
  await page.getByRole("button", { name: "새 버전으로 저장" }).click();
  await expect(page.getByText("v2으로 저장했습니다", { exact: false })).toBeVisible();

  expect(gateway.saves).toHaveLength(1);
  const saved = gateway.saves[0] as {
    base_version: number;
    deploy: boolean;
    note: string;
    graph: typeof graph;
  };
  expect(saved.base_version).toBe(1);
  expect(saved.deploy).toBe(false);
  expect(saved.note).toBe("기본 모델 교체");
  expect(saved.graph.elements.find((element) => element.id === "premium")?.properties).toMatchObject({
    model: "gpt-4.1-2026",
  });

  // The canvas scrolls inside its frame; the page itself never scrolls sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("simulates a failure and highlights the path taken", async ({ page }) => {
  const gateway = await install(page);
  await page.goto("routing/dynamic/drt_support");
  await page.getByRole("tab", { name: "시뮬레이션" }).click();
  await page.getByRole("checkbox", { name: /premium \(gpt-4.1\)/u }).check();
  await page.getByRole("button", { name: "시뮬레이션 실행" }).click();
  await expect(
    page.getByText("X-Dynamic-Route-Path: start>plan:false>premium:failed>light:success>end"),
  ).toBeVisible();
  const path = page.getByRole("list", { name: "지나간 경로" });
  await expect(path.getByRole("listitem")).toHaveCount(5);
  await expect(page.getByRole("img", { name: /모델 premium.*시뮬레이션: 실패/u })).toBeVisible();
  await expect(page.getByText("90.0%")).toBeVisible();
  expect(gateway.simulations[0]).toMatchObject({ failing: ["premium"], route_id: route.id });
});

test("keeps the editor usable on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 900 });
  await install(page);
  await page.goto("routing/dynamic/drt_support");
  const flow = page.getByRole("group", { name: /support 경로 흐름/u });
  await expect(flow).toBeVisible();
  await flow.getByRole("button", { name: /비율 분배 split/u }).click();
  await expect(page.getByText("합계 100%")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("shows where traffic ended, open limits and recent paths", async ({ page }) => {
  const gateway = await install(page);
  await page.goto("routing/dynamic/drt_support");
  await page.getByRole("tab", { name: "트래픽" }).click();
  await expect(page.getByText("30건 · 평균 410ms")).toBeVisible();
  await expect(page.getByText("[REDACTED_EMAIL]", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "입출력" })).toHaveAttribute("href", /request_id=req-1/u);
  await page.getByRole("combobox", { name: "트래픽 기간" }).selectOption("168");
  await expect.poll(() => gateway.activityQueries.at(-1)).toBe("?hours=168");
  await expect(page.getByText("트래픽을 불러오지 못했습니다.")).toHaveCount(0);
});
