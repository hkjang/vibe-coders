import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installModelResourceSearch, modelName, betaRef } from "../fixtures/model-resource-search-browser";
async function search(page: Page) {
  await page.goto("system/settings?tab=runtime");
  await page.getByRole("button", { name: "명령 팔레트 열기", exact: true }).click();
  const palette = page.getByRole("dialog", { name: "명령 팔레트", exact: true });
  await palette.getByRole("button", { name: "자원 검색", exact: true }).click();
  await palette.getByRole("button", { name: "검색 대상: 전체 자원" }).click();
  await palette
    .getByRole("group", { name: "검색할 자원 종류" })
    .getByRole("button", { name: "모델", exact: true })
    .click();
  await palette.getByRole("combobox").fill("정산");
  return palette;
}
test("공급자별 모델 검색·부분 실패 재시도·상세 새로고침", async ({ page }) => {
  const fixture = await installModelResourceSearch(page);
  const palette = await search(page);
  await expect(palette.getByRole("option")).toHaveCount(2);
  await expect(palette.getByRole("status")).toContainText("일부 목록만 확인됨");
  fixture.state.partial = false;
  await palette.getByRole("button", { name: "자원 검색 다시 시도" }).click();
  await expect(palette.getByRole("status")).not.toContainText("일부 목록만 확인됨");
  expect(fixture.searches.at(-1)).toEqual({ query: "정산", kinds: ["model"] });
  await palette.getByRole("option", { name: /보조 공급자/ }).click();
  const detail = page.getByRole("dialog", { name: modelName, exact: true });
  await expect(detail).toContainText("보조 공급자");
  const destination = new URL(page.url());
  expect(destination.searchParams.get("model_provider")).toBe(betaRef);
  expect(destination.searchParams.has("source")).toBe(false);
  await page.reload();
  await expect(detail).toContainText("보조 공급자");
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  expect(fixture.state.reads).toContain("/admin/models");
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
test("모델 목록 조회 실패에서 키보드 재시도", async ({ page }) => {
  const fixture = await installModelResourceSearch(page);
  fixture.state.fail = true;
  const palette = await search(page);
  await expect(palette.getByRole("status")).toContainText("모델 (조회 실패)");
  await expect(palette.getByRole("option")).toHaveCount(0);
  fixture.state.fail = false;
  fixture.state.partial = false;
  await palette.getByRole("button", { name: "자원 검색 다시 시도" }).focus();
  await page.keyboard.press("Enter");
  await expect(palette.getByRole("option")).toHaveCount(2);
  await expect(palette.getByRole("combobox")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: modelName, exact: true })).toContainText("보조 공급자");
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`모델 검색 접근성·시각 ${theme}-${width}`, async ({ page }) => {
      const fixture = await installModelResourceSearch(page);
      await page.clock.setFixedTime(new Date("2026-11-13T01:00:00Z"));
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const palette = await search(page);
      await expect(palette.getByRole("option")).toHaveCount(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const violations = await page.evaluate(async () =>
        (
          await (window as unknown as { axe: { run: (selector: string) => Promise<AxeResults> } }).axe.run(
            '[role="dialog"]',
          )
        ).violations.map(({ id }) => id),
      );
      expect(violations).toEqual([]);
      await expect(palette).toHaveScreenshot(`model-search-${theme}-${width}.png`);
      await page.keyboard.press("Escape");
      await expect(palette).toBeHidden();
      expect(fixture.writes).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  }
