import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installBulkStage } from "../fixtures/prompt-stage-bulk-browser";
async function open(page: Page) {
  await page.goto("prompts/library?tab=promotions");
  const trigger = page.getByRole("button", { name: "일괄 승격 검토", exact: true });
  await trigger.focus();
  await trigger.press("Enter");
  const dialog = page.getByRole("dialog", { name: "프롬프트 일괄 승격 검토" });
  await expect(dialog.getByText("승격 대상 1", { exact: true })).toBeVisible();
  return { dialog, trigger };
}
async function fill(page: Page) {
  const dialog = page.getByRole("dialog", { name: "프롬프트 일괄 승격 검토" });
  await dialog.getByRole("textbox", { name: /^변경 사유/ }).fill("전체 버전과 변경 전후를 확인했습니다.");
  await dialog.getByRole("textbox", { name: /^변경할 버전 수 확인/ }).fill("2");
  await dialog.getByRole("checkbox").check();
}
test("일괄 검토 후 전체 수와 사유를 확인해 한 번 적용하고 초점을 복귀한다", async ({ page }) => {
  const fixture = await installBulkStage(page);
  const { dialog, trigger } = await open(page);
  expect(fixture.bulkChanges).toEqual([]);
  await fill(page);
  const save = dialog.getByRole("button", { name: "확인한 2개 승격" });
  await save.focus();
  await save.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(fixture.bulkChanges).toHaveLength(1);
  expect(fixture.bulkChanges[0]).toEqual({
    window: fixture.review.window,
    since: fixture.review.since,
    until: fixture.review.until,
    revision: fixture.review.revision,
    reason: "전체 버전과 변경 전후를 확인했습니다.",
  });
  fixture.check();
});
test("일괄 적용 충돌은 입력을 보존하고 재전송을 막는다", async ({ page }) => {
  const fixture = await installBulkStage(page);
  fixture.bulkState.writeStatus = 409;
  const { dialog } = await open(page);
  await fill(page);
  await dialog.getByRole("button", { name: "확인한 2개 승격" }).click();
  await expect(dialog.getByText(/검토 이후 단계·관측 기록/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "확인한 2개 승격" })).toBeDisabled();
  expect(fixture.bulkChanges).toHaveLength(1);
  expect(await page.getByText("private-bulk-write-error").count()).toBe(0);
  fixture.check();
});
test("읽기 전용 사용자는 검토만 하고 변경할 수 없다", async ({ page }) => {
  const fixture = await installBulkStage(page, true);
  const { dialog } = await open(page);
  await expect(dialog.getByRole("button", { name: "확인한 2개 승격" })).toBeDisabled();
  await expect(dialog.getByRole("textbox", { name: /^변경 사유/ })).toBeDisabled();
  expect(fixture.bulkChanges).toEqual([]);
  fixture.check();
});
test("조회 거부는 검토 내용을 폐기한다", async ({ page }) => {
  const fixture = await installBulkStage(page);
  fixture.bulkState.status = 403;
  await page.goto("prompts/library?tab=promotions");
  await page.getByRole("button", { name: "일괄 승격 검토", exact: true }).click();
  await expect(page.getByRole("heading", { name: "프롬프트 보관함 조회 권한 확인 필요" })).toBeVisible();
  await expect(page.getByText("승격 대상 1", { exact: true })).toHaveCount(0);
  expect(fixture.bulkChanges).toEqual([]);
  fixture.check();
});
for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`${theme} ${width}px 일괄 변경 검토와 확인 폼`, async ({ page }) => {
      const fixture = await installBulkStage(page);
      await page.setViewportSize({ width, height: width === 390 ? 900 : 1100 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const { dialog } = await open(page);
      const violations = () =>
        page.evaluate(
          async () =>
            (
              await (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe.run(
                document,
              )
            ).violations,
        );
      expect(await violations()).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // Document overflow alone misses content clipped inside the dialog body.
      expect(
        await dialog.locator(".dialog-body").evaluate((body) => body.scrollWidth <= body.clientWidth),
      ).toBe(true);
      if (width === 390) {
        const table = dialog.locator(".data-table-scroll");
        expect(await table.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
        await table.focus();
        await table.evaluate((element) => {
          element.dataset.keyboardScrollEnded = "false";
          element.addEventListener(
            "scrollend",
            () => {
              element.dataset.keyboardScrollEnded = "true";
            },
            { once: true },
          );
        });
        await table.press("ArrowRight");
        await expect.poll(() => table.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
        await expect(table).toHaveAttribute("data-keyboard-scroll-ended", "true");
        await table.evaluate((node) => {
          node.scrollLeft = 0;
        });
        await expect.poll(() => table.evaluate((node) => node.scrollLeft)).toBe(0);
        await dialog.getByRole("button", { name: "대화상자 닫기" }).focus();
      }
      await expect(dialog.getByRole("button", { name: "확인한 2개 승격" })).toBeInViewport();
      await expect(dialog).toHaveScreenshot(`prompt-stage-bulk-${theme}-${width}.png`, {
        animations: "disabled",
      });
      await fill(page);
      expect(await violations()).toEqual([]);
      await expect(dialog).toHaveScreenshot(`prompt-stage-bulk-confirm-${theme}-${width}.png`, {
        animations: "disabled",
      });
      await dialog.getByRole("button", { name: "취소", exact: true }).click();
      await expect(page.getByRole("alertdialog", { name: /저장하지 않은/ })).toBeVisible();
      expect(fixture.bulkChanges).toEqual([]);
      fixture.check();
    });
