import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installPromptLibrary } from "../fixtures/prompt-library-browser";
import { refreshRuntime } from "../fixtures/agent-code-editor";

async function fixture(page: Page, readOnly = true) {
  const base = await installPromptLibrary(page, readOnly);
  base.bootstrap.backend_version = "v0.86.147";
  base.bootstrap.allowed_features = ["security.redteam"];
  const feature = base.bootstrap.migration_registry[0];
  if (!feature) throw Error("missing feature");
  Object.assign(feature, {
    feature_id: "security.redteam",
    title: "레드팀 자동화",
    app_path: "/app/redteam",
    legacy_path: "/admin#/redteam",
    required_permission: "admin:read",
    risk_level: "critical",
  });
  const campaign = {
    id: "public-campaign",
    name: "공개 검사 캠페인",
    scope: "all",
    status: "draft",
    execution_mode: "dry-run",
    probe_pack_ids: ["public-pack"],
    budget_limit_krw: 1000,
    qps_limit: 1,
    target_filter: {},
  };
  const writes: string[] = [];
  await page.route("**/admin/redteam/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() !== "GET") {
      writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 500, json: { error: { message: "unexpected fixture write" } } });
    }
    if (url.pathname.endsWith("/campaigns")) return route.fulfill({ json: { campaigns: [campaign] } });
    if (url.pathname.endsWith("/probe-packs"))
      return route.fulfill({
        json: {
          probe_packs: [
            {
              id: "public-pack",
              name: "공개 검사 묶음",
              category: "prompt_injection",
              enabled: true,
              requires_approval: false,
              severity: "low",
              cases: [],
            },
          ],
        },
      });
    if (url.pathname.endsWith("/schedules"))
      return route.fulfill({
        json: {
          schedules: [
            {
              id: "public-schedule",
              campaign_template_id: campaign.id,
              cron_expr: "@daily",
              enabled: true,
            },
          ],
        },
      });
    if (url.pathname.endsWith("/kill-switch")) return route.fulfill({ json: { enabled: false } });
    return route.fulfill({ json: {} });
  });
  return { ...base, feature, writes };
}

for (const statusOnly of [false, true]) {
  test(`읽기 전용 ${statusOnly ? "상태" : "설정"}은 관리자 변경과 폼 제출을 막고 조회를 유지한다`, async ({
    page,
  }) => {
    const api = await fixture(page, !statusOnly);
    if (statusOnly) api.feature.status = "preview_read_only";
    await page.goto("redteam?tab=campaigns");
    await expect(page.getByRole("button", { name: "캠페인 만들기", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "공개 검사 캠페인 수정", exact: true })).toHaveAttribute(
      "title",
      /읽기 전용/,
    );
    await expect(page.getByLabel("레드팀 실행 키", { exact: true })).toBeDisabled();
    await page.getByRole("tab", { name: "대상·검사 묶음", exact: true }).click();
    await expect(page.getByRole("button", { name: "프롬프트 추가", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "CSV 가져오기", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "CSV 내보내기(엑셀)", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "공개 검사 묶음 검사 보기", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "일정", exact: true }).click();
    const submit = page.getByRole("button", { name: "일정 추가", exact: true });
    await expect(submit).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "공개 검사 캠페인 일정 중지", exact: true }),
    ).toBeDisabled();
    await submit.evaluate((element) =>
      element.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await page.getByRole("button", { name: "새로고침", exact: true }).click();
    await expect(page.getByRole("button", { name: "새로고침", exact: true })).toBeEnabled();
    expect(api.writes).toEqual([]);
    api.check();
  });
}

test("설정 갱신으로 열린 폼과 실행 키를 폐기하고 쓰기 복구 후에도 되살리지 않는다", async ({ page }) => {
  const api = await fixture(page, false);
  await page.goto("redteam?tab=campaigns");
  await page.getByLabel("레드팀 실행 키", { exact: true }).fill("public-synthetic-execution-key");
  await page.getByRole("button", { name: "공개 검사 캠페인 수정", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "캠페인 수정", exact: true });
  await expect(dialog).toBeVisible();
  api.feature.read_only = true;
  await refreshRuntime(page);
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("레드팀 실행 키", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "공개 검사 캠페인 수정", exact: true })).toBeDisabled();
  api.feature.read_only = false;
  await refreshRuntime(page);
  await expect(page.getByRole("button", { name: "공개 검사 캠페인 수정", exact: true })).toBeEnabled();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("레드팀 실행 키", { exact: true })).toHaveValue("");
  expect(api.writes).toEqual([]);
  api.check();
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`조회 모드 ${theme} ${width} 키보드·접근성·시각 기준`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const api = await fixture(page);
      await page.goto("redteam?tab=schedules");
      await expect(page.getByRole("button", { name: "일정 추가", exact: true })).toBeDisabled();
      await page.getByRole("tab", { name: "일정", exact: true }).focus();
      await page.keyboard.press("ArrowLeft");
      await expect(page.getByRole("tab", { name: "실행·조치", exact: true })).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("tab", { name: "일정", exact: true })).toBeFocused();
      // Record the page from its origin after keyboard navigation scrolled the focused tab.
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      await expect(page).toHaveScreenshot(`redteam-readonly-${theme}-${width}.png`, { fullPage: true });
      const result = await page.evaluate(async () =>
        (window as unknown as { axe: { run: () => Promise<AxeResults> } }).axe.run(),
      );
      expect(result.violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(api.writes).toEqual([]);
      api.check();
    });
  }
}
