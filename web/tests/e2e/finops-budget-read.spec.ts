import { expect, test, type Page } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

async function install(page: Page) {
  const user = {
    id: "public-budget-reader",
    email: "budget@example.invalid",
    name: "예산 조회 검증",
    role: "admin",
    roles: ["admin"],
    scopes: ["admin:read", "costs:read"],
    team_id: "",
  };
  const bootstrap: UiBootstrapResponse = {
    backend_version: "v0.86.61",
    ui_version: "budget-read-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/finops",
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
    allowed_features: ["finops.overview", "access.users"],
    capabilities: { raw_prompt_view: false },
    migration_registry: [
      {
        feature_id: "finops.overview",
        title: "비용 관리",
        app_path: "/app/finops",
        legacy_path: "/admin#/billing",
        status: "preview",
        risk_level: "medium",
        required_permission: "costs:read",
        read_only: true,
        enabled_roles: ["admin"],
        rollout_percent: 100,
        fallback_enabled: true,
        minimum_api_version: "v0.84.0",
        available: true,
      },
      {
        feature_id: "access.users",
        title: "사용자와 팀",
        app_path: "/app/access/users",
        legacy_path: "/admin#/users",
        status: "preview",
        risk_level: "medium",
        required_permission: "admin:read",
        read_only: true,
        enabled_roles: ["admin"],
        rollout_percent: 100,
        fallback_enabled: true,
        minimum_api_version: "v0.84.0",
        available: true,
      },
    ],
    system_status: { status: "healthy" },
    legacy_route_map: {},
  };
  let anomalyStatus = 200;
  let alertStatus = 200;
  const queries: { path: string; query: string }[] = [];
  const unexpected: string[] = [];
  await page.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/app/")) return route.continue();
    const json = (value: unknown) => route.fulfill({ json: value });
    if (request.method() !== "GET") {
      unexpected.push(request.method());
      return route.fulfill({ status: 500 });
    }
    if (url.pathname === "/auth/me") return json({ authenticated: true, user });
    if (url.pathname === "/admin/ui-bootstrap") return json(bootstrap);
    if (url.pathname === "/health") return json({ status: "ok" });
    if (url.pathname === "/admin/cost/anomalies" || url.pathname === "/admin/budgets/alerts") {
      queries.push({ path: url.pathname, query: url.search });
      const status = url.pathname === "/admin/cost/anomalies" ? anomalyStatus : alertStatus;
      if (status !== 200)
        return route.fulfill({
          status,
          headers: { "X-Request-ID": "public-budget-request" },
          json: { error: { message: "fixture failure", code: "read_failed" } },
        });
      return json(
        url.pathname === "/admin/cost/anomalies"
          ? { budget_projections: [], over_projected: [], session_loops: [] }
          : {
              alerts: [
                {
                  scope: "team",
                  scope_value: "공개 예산팀",
                  severity: "critical",
                  monthly_krw: 1000,
                  spent_krw: 1200,
                },
              ],
              warn: 1,
              critical: 1,
            },
      );
    }
    if (url.pathname === "/admin/quotas") return json({ quotas: [], usage: [] });
    if (url.pathname === "/admin/budgets") return json({ budgets: [] });
    if (url.pathname === "/admin/budgets/projection") return json({ teams: [], exceeding: 0 });
    unexpected.push(url.pathname);
    return route.fulfill({ status: 500 });
  });
  return {
    queries,
    unexpected,
    anomalyStatus: (value: number) => {
      anomalyStatus = value;
    },
    alertStatus: (value: number) => {
      alertStatus = value;
    },
  };
}

test("예산 최초 오류는 빈 상태가 아니며 재시도로 복구한다", async ({ page }) => {
  const fixture = await install(page);
  fixture.anomalyStatus(500);
  await page.goto("/app/finops?tab=budget");
  await expect(page.getByText("예산 소진 예측을(를) 불러오지 못했습니다.")).toBeVisible();
  await expect(page.getByText("예산이 없습니다.")).toHaveCount(0);
  await expect(page.getByText("반복 호출이 없습니다.")).toHaveCount(0);
  await expect(page.getByText("팀 · 공개 예산팀")).toBeVisible();
  fixture.anomalyStatus(200);
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.getByText("예산이 없습니다.")).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test("예산 갱신 오류는 이전 경고를 유지하지만 권한 거부는 숨긴다", async ({ page }) => {
  const fixture = await install(page);
  await page.goto("/app/finops?tab=budget");
  await expect(page.getByText("팀 · 공개 예산팀")).toBeVisible();
  fixture.alertStatus(500);
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByText(/마지막으로 확인한 값을 표시합니다/u)).toBeVisible();
  await expect(page.getByText("팀 · 공개 예산팀")).toBeVisible();
  fixture.alertStatus(403);
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.getByText("예산 조회 권한을 다시 확인하세요.")).toBeVisible();
  await expect(page.getByText("팀 · 공개 예산팀")).toHaveCount(0);
  fixture.alertStatus(200);
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.getByText("팀 · 공개 예산팀")).toBeVisible();
  expect(
    fixture.queries
      .filter((query) => query.path.endsWith("/alerts"))
      .every((query) => query.query === "?all=1"),
  ).toBe(true);
  expect(fixture.unexpected).toEqual([]);
});

test("예산 기간은 URL로 복원되고 관리 링크는 할당량 탭을 연다", async ({ page }) => {
  const fixture = await install(page);
  await page.goto("/app/finops?tab=budget&window=7d");
  await expect(page.getByLabel("반복 호출 조회 기간")).toHaveValue("7d");
  await page.getByLabel("반복 호출 조회 기간").selectOption("24h");
  await expect(page).toHaveURL(/window=24h/u);
  await page.reload();
  await expect(page.getByLabel("반복 호출 조회 기간")).toHaveValue("24h");
  await expect(page.getByText("팀 · 공개 예산팀")).toBeVisible();
  await page.getByRole("link", { name: "할당량·예산 관리 열기" }).click();
  await expect(page).toHaveURL(/access\/users\?tab=quotas/u);
  await expect(page.getByRole("tab", { name: "할당량·예산", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(fixture.queries.some((query) => query.query.includes("window=24h"))).toBe(true);
  expect(fixture.unexpected).toEqual([]);
});

test("모바일 어두운 예산 화면은 키보드·접근성·가로 넘침을 검증한다", async ({ page }, testInfo) => {
  await install(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await page.goto("/app/finops?tab=budget");
  await expect(page.getByText("팀 · 공개 예산팀")).toBeVisible();
  const filter = page.getByLabel("반복 호출 조회 기간");
  await filter.focus();
  await expect(filter).toBeFocused();
  await filter.press("ArrowUp");
  await filter.press("Enter");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(
    await page.evaluate(async () => {
      const axe = (
        window as unknown as { axe: { run(root: Document): Promise<{ violations: { id: string }[] }> } }
      ).axe;
      return (await axe.run(document)).violations.map((item) => item.id);
    }),
  ).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("budget-read-mobile.png"), fullPage: true });
});
