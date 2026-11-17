import { expect, test, type Page } from "@playwright/test";
import { visibleState } from "../fixtures/table-state-visibility";
import type { AxeResults } from "axe-core";
import { installPromptLibrary } from "../fixtures/prompt-library-browser";

type State = "empty" | "error" | "loading" | "loaded";
async function fixture(page: Page, configurable: boolean, initial: State) {
  await page.clock.setFixedTime(new Date("2026-11-17T00:00:00Z"));
  const base = await installPromptLibrary(page, true);
  base.bootstrap.backend_version = configurable ? "v0.86.149" : "v0.86.144";
  base.bootstrap.allowed_features = ["security.redteam"];
  Object.assign(base.bootstrap.migration_registry[0] ?? {}, {
    feature_id: "security.redteam",
    title: "레드팀 자동화",
    app_path: "/app/redteam",
    legacy_path: "/admin#/redteam",
    required_permission: "admin:read",
    risk_level: "critical",
  });
  let state = initial,
    release = () => {},
    reads = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/admin/redteam/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    expect(request.method()).toBe("GET");
    if (url.pathname.endsWith("/kill-switch")) return route.fulfill({ json: { enabled: false } });
    if (!url.pathname.endsWith("/runs")) return route.fulfill({ json: {} });
    reads++;
    if (state === "loading") await gate;
    if (state === "error")
      return route.fulfill({ status: 503, json: { error: { code: "public-unavailable" } } });
    const runs =
      state === "loaded"
        ? [
            {
              id: "public-restored-run",
              campaign_id: "public-campaign",
              target_id: "public-target",
              status: "passed",
              mode: "dry-run",
              total_cases: 1,
              failed_cases: 0,
              risk_score: 0,
              cost_krw: 0,
              started_at: "2026-11-17T00:00:00Z",
              ended_at: "2026-11-17T00:00:01Z",
              created_at: "2026-11-17T00:00:00Z",
            },
          ]
        : [];
    return route.fulfill({
      json: configurable
        ? { runs, total: runs.length, limit: 25, offset: 0, generated_at: "2026-11-17T00:00:00Z" }
        : { runs },
    });
  });
  return {
    ...base,
    state: (value: State) => {
      state = value;
      release();
    },
    reads: () => reads,
  };
}
function tableShell(page: Page) {
  return page
    .locator(".data-table-shell")
    .filter({ has: page.getByRole("table", { name: "레드팀 캠페인 실행 이력", exact: true }) });
}

for (const configurable of [true, false])
  for (const state of ["empty", "error"] as const)
    test(`${configurable ? "열 설정 표" : "기본 표"} ${state}: 시작·중간·끝과 화면 크기 변경에도 안내가 보인다`, async ({
      page,
    }) => {
      const api = await fixture(page, configurable, state);
      await page.setViewportSize({ width: 390, height: 960 });
      await page.goto("redteam?tab=runs");
      const shell = tableShell(page);
      await expect(shell.locator(".data-table-state")).toBeVisible();
      for (const width of [390, 560, 1024]) {
        await page.setViewportSize({ width, height: 960 });
        await shell.scrollIntoViewIfNeeded();
        for (const fraction of [0, 0.5, 1]) await visibleState(shell, fraction);
      }
      if (state === "error") {
        const before = api.reads();
        api.state("loaded");
        await shell.getByRole("button", { name: "다시 시도", exact: true }).focus();
        await page.keyboard.press("Enter");
        await expect(shell.getByText("public-restored-run", { exact: true })).toBeVisible();
        await expect(shell.locator(".data-table-state")).toHaveCount(0);
        expect(api.reads()).toBeGreaterThan(before);
      }
      api.check();
    });
for (const configurable of [true, false])
  test(`${configurable ? "열 설정 표" : "기본 표"}: 로딩 골격에서 빈 상태로 전환하고 열을 유지한다`, async ({
    page,
  }) => {
    const api = await fixture(page, configurable, "loading");
    await page.setViewportSize({ width: 390, height: 960 });
    await page.goto("redteam?tab=runs");
    const shell = tableShell(page);
    await expect(shell).toHaveAttribute("aria-busy", "true");
    await expect(shell.locator(".data-table-skeleton-row")).toHaveCount(5);
    const headers = await shell.getByRole("columnheader").count();
    await shell.locator(".data-table-scroll").evaluate((node) => {
      node.scrollLeft = node.scrollWidth;
    });
    api.state("empty");
    await expect(shell.locator(".data-table-state")).toBeVisible();
    await visibleState(shell, 1);
    await expect(shell).not.toHaveAttribute("aria-busy");
    await expect(shell.getByRole("columnheader")).toHaveCount(headers);
    api.check();
  });
for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    for (const state of ["empty", "error"] as const)
      test(`표 ${state} 안내 ${theme} ${width}: 키보드·접근성·시각 기준`, async ({ page }) => {
        const api = await fixture(page, true, state);
        await page.setViewportSize({ width, height: 960 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
        await page.goto("redteam?tab=runs");
        const shell = tableShell(page);
        await expect(shell.locator(".data-table-state")).toBeVisible();
        await shell.scrollIntoViewIfNeeded();
        await visibleState(shell, 0.5);
        const results = await page.evaluate(async () =>
          (window as typeof window & { axe: { run: () => Promise<AxeResults> } }).axe.run(),
        );
        expect(results.violations).toEqual([]);
        await expect(shell).toHaveScreenshot(`table-${state}-${theme}-${width}.png`);
        api.check();
      });
