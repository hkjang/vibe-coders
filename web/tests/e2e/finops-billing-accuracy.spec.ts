import { expect, test, type Page } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

async function install(page: Page) {
  const user = {
    id: "public-cost-reader",
    email: "costs@example.invalid",
    name: "비용 조회 검증",
    role: "admin",
    roles: ["admin"],
    team_id: "",
    scopes: ["admin:read", "costs:read"],
  };
  const bootstrap: UiBootstrapResponse = {
    backend_version: "v0.86.61",
    ui_version: "finops-export-fixture",
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
    capabilities: { raw_prompt_view: false },
    allowed_features: ["finops.overview"],
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
    ],
    system_status: { status: "healthy" },
    legacy_route_map: {},
  };
  let failed = ["by_model", "budgets", "migration_candidates"];
  let legacy = false;
  let status = 200;
  const windows: string[] = [];
  const unexpected: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/app/")) return route.continue();
    const json = (body: unknown) => route.fulfill({ json: body });
    if (request.method() !== "GET") {
      unexpected.push(request.method());
      return route.fulfill({ status: 500 });
    }
    if (url.pathname === "/auth/me") return json({ authenticated: true, user });
    if (url.pathname === "/admin/ui-bootstrap") return json(bootstrap);
    if (url.pathname === "/health") return json({ status: "ok" });
    if (url.pathname === "/billing/dashboard") {
      windows.push(url.searchParams.get("window") ?? "");
      if (status !== 200)
        return route.fulfill({
          status,
          headers: { "X-Request-ID": "public-billing-failure" },
          json: { error: { code: "billing_dashboard_unavailable", message: "fixture" } },
        });
      return json({
        since: "2026-10-01T00:00:00Z",
        total_cost_krw: 231,
        total_requests: 22,
        ...(legacy ? {} : { totals_scope: "all_retained_requests", unavailable_sections: failed }),
        by_cost_center: [{ key: "공개 비용센터", cost_krw: 230, requests: 20 }],
        by_model: failed.includes("by_model") ? null : [{ key: "공개 모델", cost_krw: 230, requests: 20 }],
        budgets: failed.includes("budgets") ? null : [],
        migration_candidates: failed.includes("migration_candidates") ? null : [],
        estimated_savings_krw: 0,
      });
    }
    unexpected.push(url.pathname);
    return route.fulfill({ status: 500 });
  });
  return {
    windows,
    unexpected,
    recover: () => {
      failed = [];
      status = 200;
    },
    legacy: () => {
      legacy = true;
      failed = [];
    },
    fail: () => {
      status = 503;
    },
  };
}

test("일부 조회 오류는 정상 합계와 분리하고 재시도로 복구한다", async ({ page }) => {
  const fixture = await install(page);
  await page.goto("/app/finops?window=7d");
  await expect(page.getByText("모델별 비용 조회에 실패했습니다.", { exact: true })).toBeVisible();
  await expect(page.getByText("₩231", { exact: true })).toBeVisible();
  await expect(page.getByText("공개 비용센터", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "비용 요약" }).getByText("—", { exact: true })).toHaveCount(
    2,
  );
  fixture.recover();
  await page.getByRole("button", { name: "다시 시도", exact: true }).first().click();
  await expect(page.getByText("공개 모델", { exact: true })).toBeVisible();
  await expect(page.getByText("등록된 예산이 없습니다.", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "조회 기간", exact: true }).selectOption("24h");
  await expect.poll(() => fixture.windows.at(-1)).toBe("24h");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "조회 기간", exact: true })).toHaveValue("24h");
  expect(fixture.unexpected).toEqual([]);
});

test("이전 서버의 합계 범위를 전체 요청으로 오인하지 않도록 안내한다", async ({ page }) => {
  const fixture = await install(page);
  fixture.legacy();
  await page.goto("/app/finops");
  await expect(page.getByText("상위 모델 비용 합계", { exact: true })).toBeVisible();
  await expect(page.getByText("총 비용", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/서버 업그레이드가 필요/)).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test("전체 합계 실패 후 재시도하면 확인된 값만 표시한다", async ({ page }) => {
  const fixture = await install(page);
  fixture.fail();
  await page.goto("/app/finops");
  await expect(page.getByText(/public-billing-failure/)).toBeVisible();
  await expect(page.getByRole("region", { name: "비용 요약" }).getByText("—", { exact: true })).toHaveCount(
    4,
  );
  await expect(page.getByText("₩0", { exact: true })).toHaveCount(0);
  fixture.recover();
  await page.getByRole("button", { name: "다시 시도", exact: true }).first().click();
  await expect(page.getByText("₩231", { exact: true })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test("모바일 어두운 화면에서 부분 실패 안내와 키보드 재시도를 검증한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  const fixture = await install(page);
  await page.goto("/app/finops");
  const retry = page.getByRole("button", { name: "다시 시도", exact: true }).first();
  await expect(retry).toBeVisible();
  await retry.focus();
  await expect(retry).toBeFocused();
  for (const button of await page.getByRole("button", { name: "다시 시도", exact: true }).all()) {
    expect(
      await button.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= window.innerWidth;
      }),
    ).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(
    await page.evaluate(async () =>
      (
        await (
          window as unknown as { axe: { run(root: Document): Promise<{ violations: { id: string }[] }> } }
        ).axe.run(document)
      ).violations.map((v) => v.id),
    ),
  ).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("billing-partial-mobile.png"), fullPage: true });
  fixture.recover();
  await page.keyboard.press("Enter");
  await expect(page.getByText("공개 모델", { exact: true })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});
