import { expect, test, type Locator, type Page } from "@playwright/test";
import type axe from "axe-core";
import { installDefinitionEditor } from "../fixtures/golden-definition-browser";

async function createPrompt(page: Page) {
  await page.goto("prompts/regression");
  await page.getByRole("button", { name: "기준 프롬프트 추가", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "기준 프롬프트 추가" });
  await dialog.getByRole("textbox", { name: "이름", exact: true }).fill("공개 회귀 기준");
  await dialog.getByRole("textbox", { name: "기준 프롬프트", exact: true }).fill("한글로 인사하세요.");
  return dialog;
}
async function approve(dialog: Locator) {
  await dialog.getByRole("button", { name: "변경 내용 검토" }).click();
  await expect(dialog.getByRole("heading", { name: "저장 전 변경 비교" })).toBeFocused();
  await dialog.getByRole("checkbox").check();
}
async function axeViolations(page: Page) {
  return page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
    const result = await (window as unknown as { axe: typeof axe }).axe.run(document);
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      count: violation.nodes.length,
    }));
  });
}
test("기준 프롬프트 등록·재조회·편집은 실행 없이 정의만 저장", async ({ page }) => {
  const fixture = await installDefinitionEditor(page),
    dialog = await createPrompt(page);
  await dialog.getByRole("textbox", { name: "기대 내용", exact: true }).fill(" 안녕하세요 ");
  await dialog.getByRole("textbox", { name: "태그 (JSON 문자열 배열)" }).fill('["한글,인사"," 회귀 "]');
  await approve(dialog);
  await dialog.getByRole("button", { name: "정의 등록", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await page.getByRole("link", { name: "공개 회귀 기준", exact: true }).click();
  await page.getByRole("button", { name: "정의 편집" }).click();
  const edit = page.getByRole("dialog", { name: "기준 프롬프트 편집" });
  await expect(edit.getByRole("textbox", { name: "기대 내용", exact: true })).toHaveValue(" 안녕하세요 ");
  await edit.getByRole("textbox", { name: "이름", exact: true }).fill("수정 회귀 기준");
  await approve(edit);
  await edit.getByRole("button", { name: "수정 저장" }).click();
  await expect(page.getByRole("link", { name: "수정 회귀 기준" })).toBeVisible();
  expect(fixture.writes).toHaveLength(2);
  expect(fixture.writes[0]?.body.id).toBe(fixture.writes[1]?.body.id);
  expect(fixture.writes[1]?.body.tags).toEqual(["한글,인사", " 회귀 "]);
  fixture.check();
});
test("검증 워크플로 단계 추가·이동·검토에 출처 보존", async ({ page }) => {
  const fixture = await installDefinitionEditor(page);
  await page.goto("prompts/regression?tab=workflows&selection=public-workflow-a");
  await page.getByRole("button", { name: "정의 편집" }).click();
  const dialog = page.getByRole("dialog", { name: "검증 워크플로 편집" });
  await dialog.getByRole("button", { name: "2단계 위로 이동" }).click();
  await dialog.getByRole("button", { name: "검증 단계 추가" }).click();
  await expect(dialog.getByRole("textbox", { name: "3단계 이름", exact: true })).toBeFocused();
  await dialog.getByRole("textbox", { name: "3단계 검사 프롬프트", exact: true }).fill("추가 공개 검사");
  await approve(dialog);
  await dialog.getByRole("button", { name: "수정 저장" }).click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.writes[0]?.body.steps).toEqual([
    expect.objectContaining({ prompt: "두 번째 질문" }),
    expect.objectContaining({ baseline_score: 82.5, source_run_id: "public-source" }),
    expect.objectContaining({ prompt: "추가 공개 검사" }),
  ]);
  fixture.check();
});
test("초안 닫기·검토 후 재편집·동시 변경 보호", async ({ page }) => {
  const fixture = await installDefinitionEditor(page);
  await page.goto("prompts/regression?selection=public-prompt-a");
  await page.getByRole("button", { name: "정의 편집" }).click();
  const dialog = page.getByRole("dialog", { name: "기준 프롬프트 편집" });
  const name = dialog.getByRole("textbox", { name: "이름", exact: true });
  await name.fill("초안 보존");
  await page.keyboard.press("Escape");
  await page.getByRole("alertdialog").getByRole("button", { name: "계속 편집" }).click();
  await expect(name).toHaveValue("초안 보존");
  await approve(dialog);
  await name.fill("초안 수정");
  await expect(dialog.getByRole("button", { name: "수정 저장" })).toBeDisabled();
  await approve(dialog);
  const first = fixture.state.prompts[0];
  if (!first) throw new Error("public prompt missing");
  first.updated_at = "2031-01-01T00:00:00Z";
  await dialog.getByRole("button", { name: "수정 저장" }).click();
  await expect(dialog.getByText(/다른 변경이 있거나/)).toBeVisible();
  expect(fixture.writes).toHaveLength(0);
  fixture.check();
});
test("응답 유실 후 재전송 없이 저장 결과 확인", async ({ page }) => {
  const fixture = await installDefinitionEditor(page),
    dialog = await createPrompt(page);
  fixture.state.lostResponse = true;
  await approve(dialog);
  await dialog.getByRole("button", { name: "정의 등록", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "저장 결과 확인" })).toBeEnabled();
  await expect(dialog.getByRole("textbox", { name: "이름", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "저장 결과 확인" }).click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.writes).toHaveLength(1);
  fixture.check();
});
test("조회 전용 설정은 추가·편집 작업을 숨김", async ({ page }) => {
  const fixture = await installDefinitionEditor(page, true);
  await page.goto("prompts/regression?selection=public-prompt-a");
  await expect(page.getByRole("dialog", { name: "기준 프롬프트 상세" })).toBeVisible();
  await expect(page.getByRole("button", { name: "정의 편집" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "기준 프롬프트 추가", exact: true })).toHaveCount(0);
  expect(fixture.writes).toHaveLength(0);
  fixture.check();
});

test("저장 직전 조회 거부는 편집창·이전 내용을 숨기고 전송하지 않음", async ({ page }) => {
  const fixture = await installDefinitionEditor(page),
    dialog = await createPrompt(page);
  await approve(dialog);
  fixture.state.readStatus = 403;
  await dialog.getByRole("button", { name: "정의 등록", exact: true }).click();
  await expect(page.getByRole("heading", { name: "회귀 검증 조회 권한 확인 필요" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "한글 답변 확인" })).toHaveCount(0);
  expect(fixture.writes).toHaveLength(0);
  fixture.check();
});

test("검증 워크플로 신규 등록은 첫 단계 필수값을 확인하고 정의만 저장", async ({ page }) => {
  const fixture = await installDefinitionEditor(page);
  await page.goto("prompts/regression?tab=workflows");
  await page.getByRole("button", { name: "검증 워크플로 추가", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "검증 워크플로 추가" });
  await dialog.getByRole("textbox", { name: "이름", exact: true }).fill("신규 공개 검증");
  await dialog.getByRole("button", { name: "변경 내용 검토" }).click();
  await expect(dialog.getByRole("textbox", { name: "1단계 검사 프롬프트", exact: true })).toBeFocused();
  await dialog.getByRole("textbox", { name: "1단계 검사 프롬프트", exact: true }).fill("공개 질문");
  await approve(dialog);
  await dialog.getByRole("button", { name: "정의 등록", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("link", { name: "신규 공개 검증", exact: true })).toBeVisible();
  expect(fixture.writes).toHaveLength(1);
  fixture.check();
});
for (const colorScheme of ["light", "dark"] as const) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    test(`정의 편집 키보드·접근성 ${colorScheme} ${viewport.width}×${viewport.height}`, async ({
      page,
    }, info) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const fixture = await installDefinitionEditor(page),
        dialog = await createPrompt(page);
      await approve(dialog);
      await expect(dialog.getByRole("button", { name: "정의 등록", exact: true })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await axeViolations(page)).toEqual([]);
      await page.screenshot({ path: info.outputPath("definition-review.png") });
      await dialog.getByRole("button", { name: "정의 등록", exact: true }).focus();
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Escape");
      await page.getByRole("alertdialog").getByRole("button", { name: "변경 버리기" }).click();
      await expect(page.getByRole("button", { name: "기준 프롬프트 추가", exact: true })).toBeFocused();
      fixture.check();
    });
  }
  test(`정의 편집 시각 기준 ${colorScheme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme });
    await page.clock.setFixedTime(new Date("2030-01-04T00:00:00Z"));
    const fixture = await installDefinitionEditor(page),
      dialog = await createPrompt(page);
    await approve(dialog);
    await expect(page).toHaveScreenshot(`definition-review-${colorScheme}.png`, {
      fullPage: true,
      maxDiffPixels: 120,
    });
    fixture.check();
  });
}
