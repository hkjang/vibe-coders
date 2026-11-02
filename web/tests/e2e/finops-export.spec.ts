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
  const row = { key: "공개 정산 항목", requests: 2, tokens: 100, cost_krw: 30, errors: 7 };
  let csvStatus = 200;
  let jsonStatus = 200;
  let heldCsv: Promise<void> | undefined;
  let releaseCsv = () => {};
  let heldAllocation: Promise<void> | undefined;
  let releaseAllocation = () => {};
  const csvMonths: string[] = [];
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
    if (url.pathname === "/admin/cost/chargeback-pack") {
      const month = url.searchParams.get("month") ?? "2026-10";
      if (url.searchParams.get("format") === "csv") {
        csvMonths.push(month);
        await heldCsv;
        return route.fulfill({
          status: csvStatus,
          contentType: "text/csv",
          body: "month,dimension,key,requests,tokens,cost_krw,errors\n",
        });
      }
      if (jsonStatus !== 200)
        return route.fulfill({
          status: jsonStatus,
          json: { error: { code: "read_failed", message: "fixture" } },
        });
      return json({
        month,
        dimensions: [{ dimension: "project", total_cost_krw: 30, total_requests: 2, rows: [row] }],
      });
    }
    if (url.pathname === "/admin/cost/allocation") {
      const dimension = url.searchParams.get("dimension");
      if (dimension === "model") await heldAllocation;
      return json({
        dimension,
        rows: [
          { ...row, key: dimension === "model" ? "공개 변경 모델" : "공개 정산 항목", error_requests: 7 },
        ],
      });
    }
    unexpected.push(url.pathname);
    return route.fulfill({ status: 500 });
  });
  return {
    csvMonths,
    unexpected,
    csvStatus: (status: number) => {
      csvStatus = status;
    },
    jsonStatus: (status: number) => {
      jsonStatus = status;
    },
    holdCsv: () => {
      heldCsv = new Promise((done) => {
        releaseCsv = done;
      });
    },
    releaseCsv: () => {
      releaseCsv();
      heldCsv = undefined;
    },
    holdAllocation: () => {
      heldAllocation = new Promise((done) => {
        releaseAllocation = done;
      });
    },
    releaseAllocation: () => releaseAllocation(),
  };
}

test("정산 표는 서버 오류 건수를 읽고 적용한 월의 CSV만 저장한다", async ({ page }) => {
  const fixture = await install(page);
  await page.goto("/app/finops?tab=chargeback&month=2026-10");
  const row = page
    .getByRole("table", { name: "프로젝트 비용 배부" })
    .getByRole("row")
    .filter({ hasText: "공개 정산 항목" });
  await expect(row.getByRole("cell").last()).toHaveText("7");
  await page.getByLabel("정산 월", { exact: true }).fill("2026-09");
  await expect(page.getByRole("button", { name: "CSV 다운로드", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "조회", exact: true }).click();
  await expect(page).toHaveURL(/month=2026-09/u);
  const result = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 다운로드", exact: true }).click();
  expect((await result).suggestedFilename()).toBe("chargeback-2026-09.csv");
  expect(fixture.csvMonths).toEqual(["2026-09"]);
  expect(fixture.unexpected).toEqual([]);
});

test("정산 월 변경은 이전 CSV의 늦은 저장을 취소한다", async ({ page }) => {
  const fixture = await install(page);
  fixture.holdCsv();
  const downloads: string[] = [];
  page.on("download", (item) => downloads.push(item.suggestedFilename()));
  await page.goto("/app/finops?tab=chargeback&month=2026-10");
  await page.getByRole("button", { name: "CSV 다운로드", exact: true }).click();
  await expect.poll(() => fixture.csvMonths).toEqual(["2026-10"]);
  await page.getByLabel("정산 월", { exact: true }).fill("2026-09");
  await page.getByRole("button", { name: "조회", exact: true }).click();
  await expect(page).toHaveURL(/month=2026-09/u);
  fixture.releaseCsv();
  const result = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 다운로드", exact: true }).click();
  expect((await result).suggestedFilename()).toBe("chargeback-2026-09.csv");
  expect(downloads).toEqual(["chargeback-2026-09.csv"]);
  expect(fixture.unexpected).toEqual([]);
});

test("정산 CSV 권한 거부는 이전 표를 숨기고 명시적으로 복구한다", async ({ page }) => {
  const fixture = await install(page);
  fixture.csvStatus(403);
  await page.goto("/app/finops?tab=chargeback&month=2026-10");
  await page.getByRole("button", { name: "CSV 다운로드", exact: true }).click();
  await expect(page.getByText("비용 조회 권한을 다시 확인하세요.")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  fixture.csvStatus(200);
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.getByRole("table", { name: "프로젝트 비용 배부" })).toBeVisible();
  expect(fixture.csvMonths).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
});

test("배부 기준 변경 중에는 이전 비용과 내보내기를 사용할 수 없다", async ({ page }) => {
  const fixture = await install(page);
  fixture.holdAllocation();
  await page.goto("/app/finops?tab=allocation");
  await expect(page.getByRole("table")).toContainText("공개 정산 항목");
  await page.getByLabel("배부 기준").selectOption("model");
  await expect(page.getByRole("table")).not.toContainText("공개 정산 항목");
  await expect(page.getByRole("button", { name: "CSV 내보내기", exact: true })).toBeDisabled();
  fixture.releaseAllocation();
  await expect(page.getByRole("table")).toContainText("공개 변경 모델");
  await expect(page.getByRole("button", { name: "CSV 내보내기", exact: true })).toBeEnabled();
  expect(fixture.unexpected).toEqual([]);
});

test("모바일 정산 오류 복구와 키보드·어두운 화면 접근성을 검증한다", async ({ page }, testInfo) => {
  const fixture = await install(page);
  fixture.jsonStatus(500);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await page.goto("/app/finops?tab=chargeback&month=2026-10");
  await expect(page.getByText("비용 배부 팩을(를) 불러오지 못했습니다.")).toBeVisible();
  await expect(page.getByText("배부할 비용이 없습니다.")).toHaveCount(0);
  fixture.jsonStatus(200);
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.getByRole("table", { name: "프로젝트 비용 배부" })).toBeVisible();
  const month = page.getByLabel("정산 월", { exact: true });
  await month.focus();
  await expect(month).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await page.evaluate(async () =>
      (
        await (
          window as unknown as { axe: { run(root: Document): Promise<{ violations: { id: string }[] }> } }
        ).axe.run(document)
      ).violations.map((item) => item.id),
    ),
  ).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("chargeback-mobile.png"), fullPage: true });
});
