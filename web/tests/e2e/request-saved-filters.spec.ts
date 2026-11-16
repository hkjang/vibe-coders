import { expect, test } from "@playwright/test";
import { installRequestSavedFilters } from "../fixtures/request-saved-filters-browser";

test("공유 필터 저장·미리보기·적용·새로고침·이름 변경·삭제", async ({ page }) => {
  const fixture = await installRequestSavedFilters(page);
  await page.goto("observability/requests?model=reviewed-model&status=error&limit=25&tz=UTC");
  const save = page.getByRole("button", { name: "현재 조건 저장" });
  await save.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("reviewed-model");
  await dialog.getByRole("textbox", { name: "필터 이름" }).fill("일간 오류 검토");
  await dialog.getByRole("button", { name: "공유 필터 저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(save).toBeFocused();
  expect(fixture.writes[0]?.postDataJSON()).toEqual({
    name: "일간 오류 검토",
    view: "requests",
    params: "tz=UTC&status=error&model=reviewed-model&limit=25",
  });
  await page.getByRole("button", { name: "공유 필터", exact: true }).click();
  const select = page.getByRole("combobox", { name: "저장된 공유 필터" });
  await select.selectOption("filt_ops");
  const count = fixture.state.queryReads.length;
  await expect(page.getByLabel("저장 조건 미리보기")).toContainText("production-chat");
  expect(fixture.state.queryReads).toHaveLength(count);
  await page.getByRole("button", { name: "이 조건으로 조회" }).click();
  await expect(page).toHaveURL(/status=5xx/);
  await expect(page.locator('input[name="model"]')).toHaveValue("production-chat");
  expect(fixture.state.queryReads.at(-1)?.get("cursor")).toBeNull();
  await page.reload();
  await expect(page.locator('input[name="model"]')).toHaveValue("production-chat");
  await page.getByRole("button", { name: "공유 필터", exact: true }).click();
  await select.selectOption("filt_ops");
  await page.getByRole("button", { name: "이름 변경", exact: true }).click();
  await dialog.getByRole("textbox", { name: "필터 이름" }).fill("운영 장애 검토");
  await dialog.getByRole("button", { name: "이름 변경", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(select).toContainText("운영 장애 검토");
  expect(fixture.writes[1]?.postDataJSON()).toEqual({ name: "운영 장애 검토" });
  await page.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(dialog).toContainText("모든 관리자");
  await dialog.getByRole("button", { name: "공유 필터 삭제", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(select).not.toContainText("운영 장애 검토");
  expect(fixture.writes.map((request) => request.method())).toEqual(["POST", "PATCH", "DELETE"]);
  expect(fixture.unexpected).toEqual([]);
});

test("조회 실패 재시도와 읽기 전용 적용 및 호환되지 않는 기존 조건", async ({ page }) => {
  const fixture = await installRequestSavedFilters(page);
  const feature = fixture.bootstrap.migration_registry[0];
  if (!feature) throw new Error("Missing feature");
  feature.read_only = true;
  fixture.state.failRead = true;
  await page.goto("observability/requests");
  await page.getByRole("button", { name: "공유 필터", exact: true }).click();
  await expect(page.getByText("요청 ID: shared-filter-fixture")).toBeVisible();
  fixture.state.failRead = false;
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await page.getByRole("combobox", { name: "저장된 공유 필터" }).selectOption("filt_ops");
  await expect(page.getByRole("button", { name: "현재 조건 저장" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "삭제", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "이 조건으로 조회" }).click();
  await expect(page).toHaveURL(/status=5xx/);
  const first = fixture.state.filters[0];
  if (!first) throw new Error("Missing filter");
  first.params = "legacy_condition=hidden-value";
  await page.reload();
  await page.getByRole("button", { name: "공유 필터", exact: true }).click();
  await page.getByRole("combobox", { name: "저장된 공유 필터" }).selectOption("filt_ops");
  await expect(page.getByText(/지원하지 않거나 중복된 조건/)).toBeVisible();
  await expect(page.getByRole("button", { name: "이 조건으로 조회" })).toBeHidden();
  await expect(page.locator("body")).not.toContainText("hidden-value");
  expect(fixture.writes).toEqual([]);
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`${theme} ${width}px 공유 필터와 저장 대화상자의 접근성·키보드·화면`, async ({ page }) => {
      await installRequestSavedFilters(page);
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("observability/requests");
      await page.getByRole("button", { name: "공유 필터", exact: true }).click();
      const select = page.getByRole("combobox", { name: "저장된 공유 필터" });
      await select.selectOption("filt_ops");
      await page.mouse.move(0, 0);
      await expect(page.getByRole("region", { name: "요청 공유 필터" })).toHaveScreenshot(
        `shared-filters-${theme}-${width}.png`,
      );
      const save = page.getByRole("button", { name: "현재 조건 저장" });
      await save.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("button", { name: "대화상자 닫기" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("textbox", { name: "필터 이름" })).toBeFocused();
      await expect(dialog).toHaveScreenshot(`shared-filter-save-${theme}-${width}.png`);
      const violations = await page.evaluate(async () => {
        const axe = (
          window as unknown as { axe: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
        ).axe;
        return (await axe.run(document)).violations.map((item) => item.id);
      });
      expect(violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(save).toBeFocused();
    });
  }
}
