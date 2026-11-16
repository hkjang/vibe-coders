import { expect, test } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installContextRegistry } from "../fixtures/context-registry-browser";

test("공용 참고자료의 상태·페이지·크기를 주소와 새로고침으로 복원한다", async ({ page }) => {
  const fixture = await installContextRegistry(page);
  await page.goto("prompts/library?tab=contexts");
  const table = page.getByRole("table", { name: "공용 참고자료 목록" });
  await expect(table.getByRole("row")).toHaveCount(26);
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect(table.getByRole("row")).toHaveCount(7);
  await page.reload();
  await expect(table.getByRole("row")).toHaveCount(7);
  expect(new URL(page.url()).searchParams.get("contexts_page")).toBe("2");
  await page.getByRole("combobox", { name: "참고자료 사용 상태" }).selectOption("enabled");
  await expect(table.getByRole("row")).toHaveCount(17);
  await page.getByRole("combobox", { name: "페이지당 표시 건수" }).selectOption("50");
  await expect.poll(() => fixture.reads.at(-1)?.get("limit")).toBe("50");
  await page.goBack();
  await expect.poll(() => fixture.reads.at(-1)?.get("limit")).toBe("25");
  expect(fixture.reads.every((query) => query.get("view") === "metadata")).toBe(true);
  expect(fixture.writes).toEqual([]);
  fixture.check();
});
test("실패·빈 자료·조회 거부를 구분하고 키보드로 다시 조회한다", async ({ page }) => {
  const fixture = await installContextRegistry(page);
  await page.goto("prompts/library?tab=contexts");
  await expect(page.getByText("팀 공통 작성 지침")).toBeVisible();
  fixture.state.status = 503;
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByText(/마지막으로 확인된 내용/)).toBeVisible();
  await expect(page.getByText("팀 공통 작성 지침")).toBeVisible();
  fixture.state.status = 403;
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByRole("heading", { name: "프롬프트 보관함 조회 권한 확인 필요" })).toBeVisible();
  await expect(page.getByText("팀 공통 작성 지침")).toHaveCount(0);
  fixture.state.status = 200;
  fixture.state.empty = true;
  const retry = page.getByRole("button", { name: "권한 확인 후 다시 조회" });
  await retry.focus();
  await retry.press("Enter");
  await expect(page.getByText("조건에 맞는 참고자료가 없습니다.")).toBeVisible();
  await expect(page.getByText("private-context-failure")).toHaveCount(0);
  fixture.check();
});
test("구버전에서는 안내하고 본문 API로 우회하지 않는다", async ({ page }) => {
  const fixture = await installContextRegistry(page);
  fixture.bootstrap.backend_version = "v0.86.129";
  await page.goto("prompts/library?tab=contexts");
  await expect(page.getByText(/백엔드 v0.86.130 이상/)).toBeVisible();
  expect(fixture.reads).toEqual([]);
  fixture.check();
});
for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`${theme} ${width}px 한글 참고자료·키보드·접근성·시각 기준`, async ({ page }) => {
      const fixture = await installContextRegistry(page);
      fixture.rows.splice(3);
      await page.setViewportSize({ width, height: width === 390 ? 1400 : 1100 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto("prompts/library?tab=contexts");
      await expect(page.getByText("팀 공통 작성 지침")).toBeVisible();
      const filter = page.getByRole("combobox", { name: "참고자료 사용 상태" });
      await filter.focus();
      await expect(filter).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const nameCell = page.getByRole("cell", { name: "팀 공통 작성 지침", exact: true });
      expect(
        await nameCell.evaluate((element) => element.getBoundingClientRect().width),
      ).toBeGreaterThanOrEqual(180);
      const countHeading = page
        .getByRole("columnheader", { name: /누적 활용/ })
        .locator(".data-table-header-content");
      expect(await countHeading.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      if (width === 390) {
        const scroll = page.getByRole("main").locator(".data-table-scroll");
        await expect(scroll).toHaveAttribute("tabindex", "0");
        await scroll.focus();
        await scroll.evaluate((element) => {
          element.dataset.keyboardScrollEnded = "false";
          element.addEventListener(
            "scrollend",
            () => {
              element.dataset.keyboardScrollEnded = "true";
            },
            { once: true },
          );
        });
        await scroll.press("ArrowRight");
        await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
        await expect(scroll).toHaveAttribute("data-keyboard-scroll-ended", "true");
        await scroll.evaluate((element) => {
          element.scrollLeft = 0;
        });
        await filter.focus();
        await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBe(0);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      const violations = await page.evaluate(
        async () =>
          (
            await (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe.run(
              document,
            )
          ).violations,
      );
      expect(violations).toEqual([]);
      await expect(page.getByRole("main")).toHaveScreenshot(`context-registry-${theme}-${width}.png`, {
        animations: "disabled",
      });
      expect(fixture.writes).toEqual([]);
      fixture.check();
    });
  }
