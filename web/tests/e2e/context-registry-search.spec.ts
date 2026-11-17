import { expect, test } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installContextSearch } from "../fixtures/context-registry-search-browser";
test("이름·키 검색과 정렬을 주소·새로고침·뒤로 가기로 복원한다", async ({ page }) => {
  const fixture = await installContextSearch(page);
  await page.goto("prompts/library?tab=contexts&contexts_page=2&contexts_sort=use_count:desc");
  const input = page.getByRole("textbox", { name: "참고자료 검색" });
  await expect(input).toBeVisible();
  const initial = fixture.reads.length;
  await input.fill("%_!");
  expect(fixture.reads.length).toBe(initial);
  await input.press("Enter");
  await expect(page.getByRole("cell", { name: "특수 검색 참고자료", exact: true })).toBeVisible();
  expect(fixture.reads.at(-1)?.get("q")).toBe("%_!");
  expect(new URL(page.url()).searchParams.get("contexts_page")).toBe(null);
  await page.reload();
  await expect(input).toHaveValue("%_!");
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(2);
  await input.fill("업무");
  await page.getByRole("button", { name: "검색 적용" }).click();
  await expect(page.getByRole("table").getByRole("row").nth(1)).toContainText("업무 참고자료 31");
  await page.getByRole("combobox", { name: "참고자료 사용 상태" }).selectOption("enabled");
  await expect.poll(() => fixture.reads.at(-1)?.get("state")).toBe("enabled");
  await page.goBack();
  await expect.poll(() => fixture.reads.at(-1)?.get("state")).toBe("all");
  expect(fixture.writes).toEqual([]);
  fixture.check();
});
test("다중 정렬은 전체 목록에 적용하고 검색 비밀값은 전송하지 않는다", async ({ page }) => {
  const fixture = await installContextSearch(page);
  await page.goto("prompts/library?tab=contexts");
  const input = page.getByRole("textbox", { name: "참고자료 검색" });
  await expect(input).toBeVisible();
  await input.fill("token=private-search-value");
  await input.press("Enter");
  await expect(page.getByText(/비밀값과 제어 문자/)).toBeVisible();
  expect(fixture.reads.every((q) => !q.get("q"))).toBe(true);
  expect(page.url()).not.toContain("private-search-value");
  await page.getByRole("button", { name: "다중 정렬" }).click();
  const dialog = page.getByRole("dialog", { name: "다중 정렬 설정" });
  await dialog.getByRole("button", { name: "정렬 기준 추가" }).click();
  await dialog.getByRole("button", { name: "정렬 기준 추가" }).click();
  await dialog.getByRole("button", { name: "정렬 적용" }).click();
  await expect.poll(() => fixture.reads.at(-1)?.get("sort")).toBe("key:asc,name:asc");
  fixture.check();
});
test("조회 거부 시 검색 초안과 이전 결과를 함께 폐기한다", async ({ page }) => {
  const fixture = await installContextSearch(page);
  await page.goto("prompts/library?tab=contexts");
  const input = page.getByRole("textbox", { name: "참고자료 검색" });
  await expect(input).toBeVisible();
  await input.fill("보내지 않은 초안");
  fixture.state.status = 403;
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByRole("heading", { name: "프롬프트 보관함 조회 권한 확인 필요" })).toBeVisible();
  await expect(input).toHaveCount(0);
  expect(fixture.reads.every((q) => !q.get("q"))).toBe(true);
  fixture.check();
});
for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`${theme} ${width}px 참고자료 검색·정렬 접근성`, async ({ page }) => {
      const fixture = await installContextSearch(page);
      fixture.rows.splice(3);
      await page.setViewportSize({ width, height: width === 390 ? 1400 : 1100 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto("prompts/library?tab=contexts");
      const input = page.getByRole("textbox", { name: "참고자료 검색" });
      await expect(input).toBeVisible();
      await input.focus();
      const violations = () =>
        page.evaluate(
          async () =>
            (
              await (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe.run(
                document,
              )
            ).violations,
        );
      for (const label of ["사용 상태", "예상 토큰", "누적 활용"]) {
        const heading = page
          .getByRole("columnheader", { name: new RegExp(label) })
          .locator(".data-table-sort-button > span");
        expect(await heading.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      expect(await violations()).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page).toHaveScreenshot(`context-search-${theme}-${width}.png`, {
        fullPage: true,
        animations: "disabled",
      });
      const trigger = page.getByRole("button", { name: "다중 정렬" });
      await trigger.focus();
      await trigger.press("Enter");
      const dialog = page.getByRole("dialog", { name: "다중 정렬 설정" });
      await dialog.getByRole("button", { name: "정렬 기준 추가" }).click();
      await dialog.getByRole("button", { name: "정렬 기준 추가" }).click();
      expect(await violations()).toEqual([]);
      await expect(dialog).toHaveScreenshot(`context-sort-${theme}-${width}.png`, { animations: "disabled" });
      await dialog.getByRole("button", { name: "취소", exact: true }).click();
      await expect(trigger).toBeFocused();
      fixture.check();
    });
