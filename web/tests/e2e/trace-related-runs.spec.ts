import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// Embedded Go assets and CSP; management APIs use public synthetic fixtures.
async function install(page: Page) {
  const state = { fail: 0, denied: false, reads: [] as URL[], unexpected: [] as string[] };
  const features = ["observability.traces", "agents.workflows", "agents.apps"];
  const bootstrap: UiBootstrapResponse = {
    backend_version: "v0.86.152",
    ui_version: "fixture-related-runs",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/observability/traces",
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
    user: {
      id: "public-owner",
      email: "public@example.invalid",
      name: "운영 담당자",
      team_id: "public-team",
      roles: ["admin"],
      role: "admin",
      scopes: ["admin:read"],
    },
    roles: ["admin"],
    permissions: ["admin:read"],
    allowed_features: features,
    capabilities: { raw_prompt_view: false },
    system_status: { status: "healthy" },
    legacy_route_map: {},
    migration_registry: (
      [
        ["observability.traces", "추적 탐색기", "/app/observability/traces", "/admin#/runtime-traces"],
        ["agents.workflows", "워크플로", "/app/agents/workflows", "/admin#/workflows"],
        ["agents.apps", "AI 업무 앱", "/app/agents/apps", "/admin#/apps"],
      ] as const
    ).map(([feature_id, title, app_path, legacy_path]) => ({
      feature_id: feature_id,
      title: title,
      app_path: app_path,
      legacy_path: legacy_path,
      status: "preview_read_only",
      risk_level: "low",
      required_permission: "admin:read",
      read_only: true,
      enabled_roles: ["admin"],
      rollout_percent: 100,
      fallback_enabled: true,
      minimum_api_version: "v0.83.0",
      available: true,
    })),
  };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === "/admin/ui-bootstrap") return route.fulfill({ json: bootstrap });
    if (["/health", "/ready"].includes(url.pathname)) return route.fulfill({ json: { status: "ok" } });
    if (url.pathname === "/admin/requests")
      return route.fulfill({
        headers: { "X-Vibe-App-Requests-Version": "2" },
        json: { requests: [], limit: 50, generated_at: "2026-11-18T00:00:00Z" },
      });
    if (
      url.pathname.startsWith("/admin/traces/") &&
      url.pathname.endsWith("/runs") &&
      req.method() === "GET"
    ) {
      state.reads.push(url);
      const failure = state.fail;
      state.fail = 0;
      if (failure || state.denied)
        return route.fulfill({
          status: failure || 403,
          headers: { "X-Request-ID": "public-trace-failure" },
          json: { error: { message: "PRIVATE_SOURCE_FAILURE" } },
        });
      const kind = url.searchParams.get("kind");
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      const items =
        offset >= 31
          ? []
          : Array.from({ length: Math.min(limit, 31 - offset) }, (_, i) => ({
              row_key: `run_${String(offset + i).padStart(43, "0")}`,
              id: `${kind}-run-${offset + i + 1}`,
              resource_id: `definition-${offset + i + 1}`,
              resource_name: `${kind === "app" ? "업무 앱" : "워크플로"} ${offset + i + 1}`,
              status: i % 3 === 0 ? "error" : "ok",
              created_at: "2026-11-18T00:00:00.123456789Z",
              latency_ms: i % 3 === 0 ? null : 120 + i,
              cost_krw: i % 3 === 0 ? null : 2 + i,
              receipt_available: i === 0,
            }));
      return route.fulfill({
        headers: { "Cache-Control": "no-store" },
        json: { related_runs_version: 1, kind, limit, offset, total: 31, items },
      });
    }
    if (url.pathname.startsWith("/admin/") || url.pathname.startsWith("/auth/")) {
      state.unexpected.push(`${req.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: { message: "unexpected fixture route" } } });
    }
    return route.continue();
  });
  return state;
}
const panel = (page: Page) => page.getByRole("region", { name: "연관 실행", exact: true });
test("연관 실행은 요청이 없어도 조회하고 URL·새로고침·키보드 초점을 보존한다", async ({ page }) => {
  const api = await install(page);
  await page.goto("observability/traces?trace_id=public-trace&model=public-model");
  const region = panel(page);
  await expect(region.getByText("workflow-run-1", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "일치하는 추적 요청이 없습니다." })).toBeVisible();
  await region.getByRole("button", { name: "다음 실행", exact: true }).click();
  await expect(region.getByText("workflow-run-26", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/related_offset=25/);
  await page.reload();
  await expect(region.getByText("workflow-run-26", { exact: true })).toBeVisible();
  const select = region.getByRole("combobox", { name: "실행 종류" });
  await select.focus();
  await select.selectOption("app");
  await expect(region.getByText("app-run-1", { exact: true })).toBeVisible();
  await expect(select).toBeFocused();
  await expect(region.getByRole("link", { name: "내 실행 영수증" })).toHaveAttribute(
    "href",
    "/app/agents/apps?tab=runs&run=app-run-1",
  );
  expect(new URL(page.url()).searchParams.get("model")).toBe("public-model");
  expect(api.unexpected).toEqual([]);
});
test("조회 실패와 권한 거부는 빈 결과와 구분하고 명시적으로 복구한다", async ({ page }) => {
  const api = await install(page);
  await page.goto("observability/traces?trace_id=public-trace");
  const region = panel(page);
  await expect(region.getByText("workflow-run-1", { exact: true })).toBeVisible();
  api.fail = 500;
  await region.getByRole("button", { name: "연관 실행 새로고침" }).click();
  await expect(region.getByRole("heading", { name: "연관 실행을 불러오지 못했습니다." })).toBeVisible();
  await expect(region.getByText("workflow-run-1", { exact: true })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("PRIVATE_SOURCE_FAILURE");
  await region.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(region.getByText("workflow-run-1", { exact: true })).toBeVisible();
  api.denied = true;
  await region.getByRole("button", { name: "연관 실행 새로고침" }).click();
  await expect(page.getByText("연관 실행 조회 권한 확인 필요", { exact: true })).toBeVisible();
  expect(api.reads).toHaveLength(4);
  api.denied = false;
  await page.getByRole("button", { name: "권한 확인 후 연관 실행 다시 조회" }).click();
  await expect(panel(page).getByText("workflow-run-1", { exact: true })).toBeVisible();
  expect(api.reads).toHaveLength(5);
  expect(api.unexpected).toEqual([]);
});
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    for (const state of ["rows", "empty"] as const) {
      test(`연관 실행 ${state} ${theme} ${width} 접근성 및 시각 회귀`, async ({ page }) => {
        const api = await install(page);
        await page.setViewportSize({ width, height: 1600 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.clock.setFixedTime(new Date("2026-11-18T00:01:00Z"));
        await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
        await page.goto(
          `observability/traces?trace_id=public-trace&related_offset=${state === "empty" ? 50 : 25}`,
        );
        const region = panel(page);
        await expect(region.getByText("조회 가능한 실행 31개", { exact: false })).toBeVisible();
        await expect(page).toHaveURL(new RegExp(`related_offset=${state === "empty" ? 50 : 25}`));
        if (state === "empty")
          await expect(
            region.getByText("현재 페이지에 연관 실행이 없습니다. 추적 ID와 실행 종류를 확인하세요."),
          ).toBeVisible();
        else await expect(region.getByText("workflow-run-26", { exact: true })).toBeVisible();
        await region.scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        const results = await page.evaluate(async () =>
          (window as typeof window & { axe: { run: () => Promise<AxeResults> } }).axe.run(),
        );
        expect(results.violations).toEqual([]);
        await expect(region).toHaveScreenshot(`related-${state}-${theme}-${width}.png`);
        expect(api.unexpected).toEqual([]);
      });
    }
