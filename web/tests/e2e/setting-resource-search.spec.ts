import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installSettingSearch, globalKey, featureKey } from "../fixtures/setting-search-browser";
import { runtimeKey } from "../fixtures/settings-workspace-browser";
async function search(page: Page, query: string) {
  await page.goto("system/settings?tab=runtime&q=목록밖");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "명령 팔레트", exact: true });
  await palette.getByRole("button", { name: "자원 검색", exact: true }).click();
  await palette.getByRole("combobox").fill(query);
  return palette;
}
for (const key of [runtimeKey, globalKey, featureKey]) {
  test(`${key} 검색·정확한 상세·새로고침·뒤로·앞으로`, async ({ page }) => {
    const fixture = await installSettingSearch(page);
    const palette = await search(page, key);
    await expect(palette.getByRole("option")).toHaveCount(1);
    await palette.getByRole("combobox").press("Enter");
    const dialog = page.getByRole("dialog", {
      name: key === featureKey ? "시스템 설정 전환 설정" : key,
      exact: true,
    });
    await expect(dialog).toBeVisible();
    const destination = page.url();
    expect(Object.fromEntries(new URL(destination).searchParams)).toEqual({
      setting: key,
      tab: key.startsWith("ui.app.") ? "console" : "runtime",
    });
    await expect(dialog.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
    await page.reload();
    await expect(dialog).toBeVisible();
    await page.goBack();
    await expect(dialog).toBeHidden();
    await page.goForward();
    await expect(dialog).toBeVisible();
    expect(page.url()).toBe(destination);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(new URL(page.url()).searchParams.has("setting")).toBe(false);
    expect(fixture.searches).toEqual([{ query: key, kinds: ["setting"] }]);
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}
test("설정 검색 일부 실패에서 재시도하고 한글 설명으로 찾는다", async ({ page }) => {
  const fixture = await installSettingSearch(page, true);
  const palette = await search(page, "점진 배포");
  await expect(palette.getByRole("option")).toHaveCount(0);
  await palette.getByRole("button", { name: "자원 검색 다시 시도" }).click();
  await expect(palette.getByRole("option")).toHaveCount(1);
  expect(fixture.searches).toHaveLength(2);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`콘솔 설정 상세 접근성·시각 ${theme}-${width}`, async ({ page }) => {
      const fixture = await installSettingSearch(page);
      await page.clock.setFixedTime(new Date("2026-11-13T01:00:00Z"));
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const palette = await search(page, "점진 배포");
      await expect(palette.getByRole("option")).toHaveCount(1);
      await palette.getByRole("combobox").press("Enter");
      const dialog = page.getByRole("dialog", { name: "시스템 설정 전환 설정", exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveCSS("opacity", "1");
      await expect(dialog.getByRole("button", { name: "저장", exact: true })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const violations = await page.evaluate(async () =>
        (
          await (window as unknown as { axe: { run: (selector: string) => Promise<AxeResults> } }).axe.run(
            '[role="dialog"]',
          )
        ).violations.map(({ id }) => id),
      );
      expect(violations).toEqual([]);
      await expect(dialog).toHaveScreenshot(`setting-search-${theme}-${width}.png`);
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
      expect(fixture.writes).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  }
