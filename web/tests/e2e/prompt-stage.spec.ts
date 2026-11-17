import { expect, test } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installPromptStages } from "../fixtures/prompt-stage-browser";

test("단계 필터·기간·페이지를 주소와 새로고침으로 복원한다", async ({ page }) => {
  const fixture = await installPromptStages(page);
  await page.goto("prompts/library?tab=promotions");
  const table = page.getByRole("table", { name: "프롬프트 버전별 단계 목록" });
  await expect(table.getByRole("row")).toHaveCount(26);
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect(table.getByRole("row")).toHaveCount(7);
  await page.reload();
  await expect(table.getByRole("row")).toHaveCount(7);
  await page.getByRole("combobox", { name: "관리 단계" }).selectOption("validation");
  await expect(table.getByRole("row")).toHaveCount(11);
  await page.getByRole("combobox", { name: "관측 기간" }).selectOption("24h");
  await expect.poll(() => fixture.reads.at(-1)?.get("window")).toBe("24h");
  expect(new URL(page.url()).searchParams.get("stages_page")).toBeNull();
  await page.reload();
  await expect(page.getByRole("combobox", { name: "관측 기간" })).toHaveValue("24h");
  expect(fixture.changes).toEqual([]);
  fixture.check();
});
test("키보드로 변경 내용을 확인하고 한 번 저장한 뒤 원래 버튼으로 복귀한다", async ({ page }) => {
  const fixture = await installPromptStages(page);
  await page.goto("prompts/library?tab=promotions");
  const row = page.getByRole("row").filter({ has: page.getByText("업무 요약", { exact: true }) });
  const trigger = row.getByRole("button", { name: "단계 변경", exact: true });
  await trigger.focus();
  await trigger.press("Enter");
  const dialog = page.getByRole("dialog", { name: "프롬프트 단계 변경" });
  await dialog.getByRole("combobox", { name: "변경할 단계" }).selectOption("validation");
  await dialog.getByRole("textbox", { name: "변경 사유" }).fill("검토 근거 확인");
  await dialog.getByRole("checkbox").check();
  const save = dialog.getByRole("button", { name: "확인한 단계로 변경" });
  await save.focus();
  await save.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(row.getByText("검증", { exact: true })).toBeVisible();
  expect(fixture.changes).toHaveLength(1);
  expect(fixture.changes[0]).toMatchObject({
    revision: "b".repeat(43),
    reason: "검토 근거 확인",
    stage: "validation",
  });
  fixture.check();
});
test("동시 수정 충돌과 미확인 저장 결과는 다시 제출하지 않는다", async ({ page }) => {
  const fixture = await installPromptStages(page);
  fixture.state.writeStatus = 409;
  await page.goto("prompts/library?tab=promotions");
  await page.getByRole("button", { name: "단계 변경", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "프롬프트 단계 변경" });
  await dialog.getByRole("combobox", { name: "변경할 단계" }).selectOption("validation");
  await dialog.getByRole("textbox", { name: "변경 사유" }).fill("충돌 확인");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "확인한 단계로 변경" }).click();
  await expect(dialog.getByText(/다른 관리자가 단계를 수정/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "확인한 단계로 변경" })).toBeDisabled();
  expect(fixture.changes).toHaveLength(1);
  expect(await page.getByText("private-stage-error").count()).toBe(0);
  fixture.check();
});
test("읽기 전용 권한과 구버전을 안내하고 단계 쓰기를 차단한다", async ({ page }) => {
  const fixture = await installPromptStages(page, true);
  await page.goto("prompts/library?tab=promotions");
  await expect(page.getByRole("button", { name: "단계 변경", exact: true }).first()).toBeDisabled();
  fixture.bootstrap.backend_version = "v0.86.131";
  fixture.reads.splice(0);
  await page.reload();
  await expect(page.getByText(/백엔드 v0.86.132 이상/)).toBeVisible();
  expect(fixture.reads).toEqual([]);
  expect(fixture.changes).toEqual([]);
  fixture.check();
});
test("단계 조회 실패와 권한 거부를 구분한다", async ({ page }) => {
  const fixture = await installPromptStages(page);
  await page.goto("prompts/library?tab=promotions");
  await expect(page.getByText("업무 요약", { exact: true })).toBeVisible();
  fixture.state.status = 503;
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByText(/마지막으로 확인된 내용/)).toBeVisible();
  await expect(page.getByRole("button", { name: "단계 변경", exact: true }).first()).toBeDisabled();
  fixture.state.status = 403;
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByRole("heading", { name: "프롬프트 보관함 조회 권한 확인 필요" })).toBeVisible();
  await expect(page.getByText("업무 요약", { exact: true })).toHaveCount(0);
  fixture.state.status = 200;
  fixture.state.empty = true;
  await page.getByRole("button", { name: "권한 확인 후 다시 조회" }).click();
  await expect(
    page.getByText("선택 기간에 관측되거나 단계가 등록된 프롬프트 버전이 없습니다."),
  ).toBeVisible();
  fixture.check();
});
for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`${theme} ${width}px 단계 목록·폼의 접근성과 시각 기준`, async ({ page }) => {
      const fixture = await installPromptStages(page);
      fixture.rows.splice(3);
      await page.setViewportSize({ width, height: width === 390 ? 1400 : 1100 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto("prompts/library?tab=promotions");
      await expect(page.getByText("업무 요약", { exact: true })).toBeVisible();
      const filter = page.getByRole("combobox", { name: "관리 단계" });
      await filter.focus();
      await expect(filter).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const violations = async () =>
        page.evaluate(
          async () =>
            (
              await (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe.run(
                document,
              )
            ).violations,
        );
      expect(await violations()).toEqual([]);
      await expect(page.getByRole("button", { name: "단계 변경", exact: true }).first()).toBeInViewport();
      await expect(page.getByRole("main")).toHaveScreenshot(`prompt-stage-${theme}-${width}.png`, {
        animations: "disabled",
      });
      await page.getByRole("button", { name: "단계 변경", exact: true }).first().click();
      const dialog = page.getByRole("dialog", { name: "프롬프트 단계 변경" });
      await dialog.getByRole("combobox", { name: "변경할 단계" }).selectOption("validation");
      await dialog.getByRole("textbox", { name: "변경 사유" }).fill("검증 결과와 적용 범위를 확인했습니다.");
      await dialog.getByRole("checkbox").check();
      expect(await violations()).toEqual([]);
      expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await expect(dialog).toHaveScreenshot(`prompt-stage-form-${theme}-${width}.png`, {
        animations: "disabled",
      });
      await dialog.getByRole("button", { name: "취소", exact: true }).click();
      await expect(page.getByRole("alertdialog", { name: /저장하지 않은/ })).toBeVisible();
      expect(fixture.changes).toEqual([]);
      fixture.check();
    });
