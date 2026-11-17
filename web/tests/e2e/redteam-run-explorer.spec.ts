import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installPromptLibrary } from "../fixtures/prompt-library-browser";

async function fixture(page: Page) {
  await page.clock.setFixedTime(new Date("2026-11-17T00:00:00Z"));
  const base = await installPromptLibrary(page, true);
  base.bootstrap.backend_version = "v0.86.146";
  base.bootstrap.allowed_features = ["security.redteam"];
  Object.assign(base.bootstrap.migration_registry[0] ?? {}, {
    feature_id: "security.redteam",
    title: "레드팀 자동화",
    app_path: "/app/redteam",
    legacy_path: "/admin#/redteam",
    required_permission: "admin:read",
    risk_level: "critical",
  });
  const runs = Array.from({ length: 127 }, (_, i) => ({
    id: `public-run-${String(i).padStart(3, "0")}`,
    campaign_id: "public-campaign",
    target_id: "public-target",
    mode: "dry-run",
    status: i % 4 === 0 ? "stopped" : "passed",
    total_cases: 12,
    failed_cases: i % 4 === 0 ? 2 : 0,
    risk_score: i % 4 === 0 ? 35 : 0,
    cost_krw: 0,
    started_at: "2026-11-16T15:00:00Z",
    ended_at: "2026-11-16T15:01:00Z",
    created_at: "2026-11-16T15:00:00Z",
  }));
  const reads: URLSearchParams[] = [];
  let failure = false;
  await page.route("**/admin/redteam/**", async (route) => {
    const url = new URL(route.request().url());
    expect(route.request().method()).toBe("GET");
    if (url.pathname.endsWith("/kill-switch")) return route.fulfill({ json: { enabled: false } });
    if (url.pathname === "/admin/redteam/runs") {
      reads.push(url.searchParams);
      expect(url.searchParams.get("view")).toBe("page");
      if (failure)
        return route.fulfill({
          status: 503,
          json: { error: { message: "조회 실패", code: "redteam_run_page_unavailable" } },
          headers: { "x-request-id": "public-history-request" },
        });
      const limit = Number(url.searchParams.get("limit")),
        offset = Number(url.searchParams.get("offset"));
      const rows = runs.filter(
        (run) => !url.searchParams.get("status") || run.status === url.searchParams.get("status"),
      );
      return route.fulfill({
        json: {
          runs: rows.slice(offset, offset + limit),
          total: rows.length,
          limit,
          offset,
          generated_at: "2026-11-17T00:00:00Z",
        },
      });
    }
    if (url.pathname.endsWith("/results")) {
      const id = url.pathname.split("/").at(-2);
      return route.fulfill({
        json: { run: runs.find((run) => run.id === id), results: [], prompts: {}, count: 0, masked: true },
      });
    }
    return route.fulfill({ json: {} });
  });
  return {
    ...base,
    reads,
    fail: () => {
      failure = true;
    },
  };
}

test("전체 이력 페이지와 상세 주소를 새로고침·뒤로 가기로 복원한다", async ({ page }) => {
  const api = await fixture(page);
  await page.goto("redteam?tab=runs&runs_page=5&runs_sort=id:asc");
  await page.getByRole("link", { name: "public-run-100 실행 상세" }).click();
  await expect(page).toHaveURL(/run=public-run-100/);
  await page.reload();
  const detail = page.getByRole("dialog", { name: "레드팀 결과" });
  await expect(detail.getByText("public-run-100", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "패널 닫기" }).click();
  await page.goBack();
  await expect(detail).toBeVisible();
  expect(api.reads.every((query) => query.get("offset") === "100")).toBe(true);
  api.check();
});
test("조건 적용으로 페이지를 초기화하고 실패한 갱신을 구분한다", async ({ page }) => {
  const api = await fixture(page);
  await page.goto("redteam?tab=runs&runs_page=5");
  await page.getByRole("button", { name: "public-run-100 결과 보기" }).waitFor();
  await page.getByRole("combobox", { name: "실행 상태", exact: true }).selectOption("stopped");
  await page.getByRole("button", { name: "조건 적용" }).click();
  await expect(page.getByText("조건에 맞는 실행 32건")).toBeVisible();
  expect(api.reads.at(-1)?.get("offset")).toBe("0");
  api.fail();
  await page.getByRole("button", { name: "이력 새로고침" }).click();
  await expect(page.getByText("public-history-request", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "public-run-000 결과 보기" })).toBeVisible();
  api.check();
});
test("잘못된 주소는 전체 조회로 바꾸지 않는다", async ({ page }) => {
  const api = await fixture(page);
  await page.goto("redteam?tab=runs&runs_page=0");
  await expect(page.getByText("실행 이력 조건을 확인하세요.")).toBeVisible();
  expect(api.reads).toHaveLength(0);
  api.check();
});
for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`${theme} ${width}: 실행 이력 필터·표·접근성`, async ({ page }) => {
      const api = await fixture(page);
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto("redteam?tab=runs&runs_page=6");
      await expect(page.getByText("조건에 맞는 실행 127건")).toBeVisible();
      if (width < 768) {
        await expect(page).toHaveScreenshot(`redteam-history-${theme}-${width}.png`, { fullPage: true });
      } else {
        await expect(page.locator(".rt-run-explorer")).toHaveScreenshot(
          `redteam-history-${theme}-${width}.png`,
        );
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const results = await page.evaluate(async () =>
        (window as typeof window & { axe: { run: (element: Element) => Promise<AxeResults> } }).axe.run(
          document.querySelector("main") ?? document.body,
        ),
      );
      expect(results.violations).toEqual([]);
      api.check();
    });
