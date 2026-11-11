import { expect, test, type Locator, type Page } from "@playwright/test";
import type axe from "axe-core";
import { installGoldenRunner } from "../fixtures/golden-run-browser";

async function prepare(page: Page, workflow = false) {
  await page.goto(`prompts/regression${workflow ? "?tab=workflows" : ""}`);
  await page.getByRole("button", { name: "회귀 검사 실행", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "회귀 검사 실행", exact: true });
  if (workflow)
    await dialog.getByRole("combobox", { name: "실행할 워크플로" }).selectOption("public-workflow-a");
  else await dialog.getByRole("checkbox", { name: "한글 답변 확인" }).check();
  await dialog
    .getByRole("textbox", { name: "비교할 모델 식별자" })
    .fill(workflow ? "public-model-a" : "public-model-a\npublic-model-b");
  return dialog;
}
async function approve(dialog: Locator) {
  await dialog.getByRole("button", { name: "실행 내용 검토", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "실행 내용 검토" })).toBeFocused();
  await dialog
    .getByRole("checkbox", { name: "실행 범위와 실제 모델 호출 비용 발생을 확인했습니다." })
    .check();
}
async function violations(page: Page) {
  return page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    );
    const result = await (window as unknown as { axe: typeof axe }).axe.run(document);
    return result.violations.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length }));
  });
}
for (const workflow of [false, true]) {
  test(`${workflow ? "워크플로" : "프롬프트"} 검토 실행·비교·초점 복귀`, async ({ page }) => {
    const fixture = await installGoldenRunner(page),
      dialog = await prepare(page, workflow);
    await expect(dialog.getByRole("button", { name: "검토한 내용으로 실행" })).toBeDisabled();
    await approve(dialog);
    await dialog.getByRole("button", { name: "검토한 내용으로 실행" }).click();
    const result = page.getByRole("dialog", { name: "회귀 검사 실행 결과" });
    await expect(result.getByRole("table", { name: "모델별 회귀 검사 비교" })).toBeVisible();
    await expect(result.getByText("통과 기준을 충족하지 못했습니다", { exact: true })).toBeVisible();
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.body.review).toEqual({
      definitions: workflow ? { "public-workflow-a": "b".repeat(64) } : { "public-prompt-a": "a".repeat(64) },
      max_calls: 64,
      max_output_tokens: 512,
    });
    await result.getByRole("button", { name: "결과 닫기" }).click();
    await expect(page.getByRole("button", { name: "회귀 검사 실행", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "이번 실행 결과" }).click();
    await expect(result).toBeVisible();
    fixture.check();
  });
}
test("검토 변경·닫기 보호와 서버 변경 거부", async ({ page }) => {
  const fixture = await installGoldenRunner(page),
    dialog = await prepare(page);
  await approve(dialog);
  await dialog.getByRole("textbox", { name: "최대 호출 수" }).fill("2");
  await expect(dialog.getByRole("button", { name: "검토한 내용으로 실행" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByRole("alertdialog").getByRole("button", { name: "계속 편집" }).click();
  await expect(dialog.getByRole("textbox", { name: "최대 호출 수" })).toHaveValue("2");
  await approve(dialog);
  fixture.state.rejected = true;
  await dialog.getByRole("button", { name: "검토한 내용으로 실행" }).click();
  await expect(dialog.getByText(/정의가 변경/)).toBeVisible();
  expect(fixture.calls).toHaveLength(1);
  fixture.check();
});
test("응답 유실은 자동 재전송 없이 실행을 잠근다", async ({ page }) => {
  const fixture = await installGoldenRunner(page),
    dialog = await prepare(page);
  fixture.state.lost = true;
  await approve(dialog);
  await dialog.getByRole("button", { name: "검토한 내용으로 실행" }).click();
  await expect(dialog.getByText("실행 결과 확인 필요", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "검토한 내용으로 실행" })).toBeDisabled();
  await expect(dialog.getByRole("textbox", { name: "비교할 모델 식별자" })).toBeDisabled();
  expect(fixture.calls).toHaveLength(1);
  fixture.check();
});
test("실행 중에는 중복 전송을 막고 실행 상태를 표시한다", async ({ page }) => {
  const fixture = await installGoldenRunner(page),
    dialog = await prepare(page);
  let release = () => {};
  fixture.state.pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await approve(dialog);
  await dialog.getByRole("button", { name: "검토한 내용으로 실행" }).click();
  await expect(dialog.getByRole("button", { name: "실행 중", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "취소", exact: true })).toBeDisabled();
  expect(fixture.calls).toHaveLength(1);
  release();
  await expect(page.getByRole("dialog", { name: "회귀 검사 실행 결과" })).toBeVisible();
  fixture.check();
});
test("페이지와 검색을 바꾸어도 이전 선택과 호출 범위를 유지한다", async ({ page }) => {
  const fixture = await installGoldenRunner(page);
  const first = fixture.state.definitions.prompts[0];
  if (!first) throw new Error("public fixture missing");
  for (let index = 0; index < 23; index++) {
    const id = `public-extra-${index}`;
    fixture.state.definitions.prompts.push({ ...first, id, name: `추가 검사 ${index}` });
    fixture.state.revisions[id] = "a".repeat(64);
  }
  const dialog = await prepare(page);
  await dialog.getByRole("button", { name: "다음 정의" }).click();
  await dialog.getByRole("checkbox", { name: "추가 검사 20", exact: true }).check();
  await dialog.getByRole("button", { name: "이전 정의" }).click();
  await expect(dialog.getByRole("checkbox", { name: "한글 답변 확인" })).toBeChecked();
  const search = dialog.getByRole("textbox", { name: "정의 이름 검색" });
  await search.fill("추가 검사 21");
  await dialog.getByRole("checkbox", { name: "추가 검사 21", exact: true }).check();
  await search.clear();
  await expect(dialog.getByRole("checkbox", { name: "한글 답변 확인" })).toBeChecked();
  await approve(dialog);
  await expect(dialog.getByText("6회 / 64회", { exact: true })).toBeVisible();
  expect(fixture.calls).toHaveLength(0);
  fixture.check();
});
test("구 서버 실행 검토 미지원과 새로고침 직접 접근", async ({ page }) => {
  const fixture = await installGoldenRunner(page);
  fixture.state.capability = false;
  await page.goto("prompts/regression?tab=workflows");
  await page.reload();
  await expect(page.getByRole("button", { name: "회귀 검사 실행", exact: true })).toBeDisabled();
  await expect(page.getByRole("link", { name: "모델 교체 검증", exact: true })).toBeVisible();
  expect(fixture.calls).toHaveLength(0);
  fixture.check();
});
test("부분 실행은 미실행 모델을 0원이나 통과로 표시하지 않는다", async ({ page }) => {
  const fixture = await installGoldenRunner(page),
    dialog = await prepare(page, true);
  fixture.state.partial = true;
  await dialog.getByRole("textbox", { name: "비교할 모델 식별자" }).fill("public-model-a\npublic-model-b");
  await approve(dialog);
  await dialog.getByRole("button", { name: "검토한 내용으로 실행" }).click();
  const result = page.getByRole("dialog", { name: "회귀 검사 실행 결과" });
  await expect(result.getByText("일부 검사만 완료되었습니다", { exact: true })).toBeVisible();
  const row = result
    .getByRole("table", { name: "모델별 회귀 검사 비교" })
    .getByRole("row")
    .filter({ hasText: "public-model-b" });
  await expect(row).toContainText("—");
  await expect(result).toContainText("예정 4건 중 2건");
  expect(fixture.calls).toHaveLength(1);
  fixture.check();
});
for (const colorScheme of ["light", "dark"] as const) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    test(`실행 검토·결과 접근성 ${colorScheme} ${viewport.width}×${viewport.height}`, async ({
      page,
    }, info) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const fixture = await installGoldenRunner(page),
        dialog = await prepare(page);
      await approve(dialog);
      await expect(dialog.getByRole("button", { name: "검토한 내용으로 실행" })).toBeInViewport();
      expect(await violations(page)).toEqual([]);
      await page.screenshot({ path: info.outputPath("run-review.png") });
      await dialog.getByRole("button", { name: "검토한 내용으로 실행" }).focus();
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      await dialog.getByRole("button", { name: "검토한 내용으로 실행" }).click();
      const result = page.getByRole("dialog", { name: "회귀 검사 실행 결과" });
      await expect(result).toBeVisible();
      expect(await violations(page)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(result.getByRole("button", { name: "결과 닫기" })).toBeInViewport();
      await page.screenshot({ path: info.outputPath("run-results.png") });
      fixture.check();
    });
  }
  test(`실행 비교 시각 기준 ${colorScheme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme });
    await page.clock.setFixedTime(new Date("2030-01-04T00:00:00Z"));
    const fixture = await installGoldenRunner(page),
      dialog = await prepare(page);
    await approve(dialog);
    await expect(page).toHaveScreenshot(`run-review-${colorScheme}.png`, {
      fullPage: true,
      maxDiffPixels: 120,
    });
    await dialog.getByRole("button", { name: "검토한 내용으로 실행" }).click();
    await expect(page.getByRole("dialog", { name: "회귀 검사 실행 결과" })).toBeVisible();
    await expect(page).toHaveScreenshot(`run-results-${colorScheme}.png`, {
      fullPage: true,
      maxDiffPixels: 120,
    });
    fixture.check();
  });
}
