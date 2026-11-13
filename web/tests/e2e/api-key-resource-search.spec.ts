import { expect, test } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installAPIKeyResourceSearch, keyFixture } from "../fixtures/api-key-resource-search-browser";

test("API 키 종류 검색에서 읽기 전용 상세·새로고침·목록으로 복귀", async ({ page }) => {
  const fixture = await installAPIKeyResourceSearch(page);
  await page.goto("access/users?tab=keys");
  await expect(page.getByRole("table", { name: "프록시 API 키 목록", exact: true })).toBeVisible();
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "명령 팔레트", exact: true });
  await palette.getByRole("button", { name: "자원 검색", exact: true }).click();
  await palette.getByRole("button", { name: "검색 대상: 전체 자원" }).click();
  await palette
    .getByRole("group", { name: "검색할 자원 종류" })
    .getByRole("button", { name: "API 키", exact: true })
    .click();
  const input = palette.getByRole("combobox");
  await expect(input).toBeFocused();
  await input.fill("정산");
  await expect(palette.getByRole("option")).toHaveCount(1);
  await input.press("Enter");
  const detail = page.getByRole("dialog", { name: "API 키 상세", exact: true });
  await expect(detail).toContainText(keyFixture.id);
  expect(fixture.searches.at(-1)).toEqual({ query: "정산", kinds: ["api_key"] });
  expect(fixture.state.reads).toContain(keyFixture.id);
  await expect(detail.getByRole("button", { name: /발급|수정|폐기/ })).toHaveCount(0);
  await page.reload();
  await expect(detail).toContainText(keyFixture.id);
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await expect(page).not.toHaveURL(/api_key_id=/u);
  const link = page.getByRole("link", { name: keyFixture.name, exact: true });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(detail).toContainText(keyFixture.id);
  await page.keyboard.press("Escape");
  await expect(link).toBeFocused();
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
test("정확한 상세의 빈 결과·재시도·권한 거부", async ({ page }) => {
  const fixture = await installAPIKeyResourceSearch(page);
  await page.goto("access/users?tab=keys&api_key_id=missing");
  const detail = page.getByRole("dialog", { name: "API 키 상세", exact: true });
  await expect(detail).toContainText("조회 가능한 API 키가 없습니다.");
  fixture.state.fail = true;
  await page.goto(`access/users?tab=keys&api_key_id=${keyFixture.id}`);
  await expect(detail).toContainText("API 키 상세 조회 실패");
  fixture.state.fail = false;
  await detail.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(detail).toContainText(keyFixture.name);
  fixture.state.denied = true;
  await page.reload();
  await expect(page.getByText(/키 조회 권한이 거부되어/)).toBeVisible();
  await expect(detail).toBeHidden();
  await expect(page.getByRole("table", { name: "프록시 API 키 목록", exact: true })).toBeHidden();
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`API 키 상세 접근성·시각 ${theme}-${width}`, async ({ page }) => {
      const fixture = await installAPIKeyResourceSearch(page);
      await page.clock.setFixedTime(new Date("2026-11-13T01:00:00Z"));
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto(`access/users?tab=keys&api_key_id=${keyFixture.id}`);
      const detail = page.getByRole("dialog", { name: "API 키 상세", exact: true });
      await expect(detail).toContainText(keyFixture.name);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const violations = await page.evaluate(async () =>
        (
          await (window as unknown as { axe: { run: (selector: string) => Promise<AxeResults> } }).axe.run(
            '[role="dialog"]',
          )
        ).violations.map(({ id }) => id),
      );
      expect(violations).toEqual([]);
      await expect(detail).toHaveScreenshot(`api-key-detail-${theme}-${width}.png`);
      await detail.getByRole("region", { name: "API 키 정보" }).focus();
      await page.keyboard.press("End");
      await expect(detail.getByRole("button", { name: "닫기", exact: true })).toBeInViewport();
      expect(fixture.writes).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  }
