import { expect, test, type Page } from "@playwright/test";
import type axe from "axe-core";
import { installPromptLab } from "../fixtures/prompt-lab-browser";
import { labExperiment } from "../fixtures/prompt-lab";

async function openRun(page: Page) {
  await page.goto("prompts/lab?exp=public_exp_1");
  await page.getByRole("button", { name: "한글 요약 검사 테스트 케이스 실행" }).click();
  return page.getByRole("dialog", { name: "테스트 케이스 실행", exact: true });
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
test("실험 검색·정렬·페이지·직접 접근·새로고침", async ({ page }) => {
  const fixture = await installPromptLab(page);
  fixture.state.experiments = Array.from({ length: 27 }, (_, index) => ({
    ...labExperiment,
    id: `public_${index}`,
    title: `공개 실험 ${String(index).padStart(2, "0")}`,
  }));
  await page.goto("prompts/lab?sort=name&page=2");
  await expect(page.getByRole("link", { name: "공개 실험 25 테스트 케이스 보기" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("link", { name: "공개 실험 25 테스트 케이스 보기" })).toBeVisible();
  const input = page.getByRole("textbox", { name: "실험 검색" });
  await input.fill("공개 실험 00");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByRole("link", { name: "공개 실험 00 테스트 케이스 보기" })).toBeVisible();
  expect(new URL(page.url()).searchParams.has("page")).toBe(false);
  await page.reload();
  await expect(input).toHaveValue("공개 실험 00");
  fixture.check();
});
test("실행 범위 확인·점수·저장 이력·키보드 복귀", async ({ page }) => {
  const fixture = await installPromptLab(page);
  await page.goto("prompts/lab");
  await page.getByRole("link", { name: "요약 품질 비교 테스트 케이스 보기" }).click();
  await expect(page).toHaveURL(/exp=public_exp_1/);
  await page.getByRole("button", { name: "한글 요약 검사 테스트 케이스 실행" }).click();
  const dialog = page.getByRole("dialog", { name: "테스트 케이스 실행", exact: true });
  await expect(dialog.getByText("1회", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/기존 서버 실행 기록에는/)).toBeVisible();
  await dialog.getByRole("button", { name: "실행", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText(/최고 점수 모델 public-model-a/)).toBeVisible();
  expect(fixture.writes).toEqual([
    { method: "POST", path: "test-cases/public_case_1/run", body: { save_prompt: false } },
  ]);
  const trigger = page.getByRole("button", { name: "한글 요약 검사 실행 이력" });
  await trigger.click();
  const history = page.getByRole("dialog", { name: "테스트 케이스 실행 이력" });
  await expect(history.getByText("public_run_1")).toBeVisible();
  await expect(history.getByText("₩0")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.reload();
  await trigger.click();
  await expect(history.getByText("public_run_1")).toBeVisible();
  fixture.check();
});
test("실행 응답 유실·닫기 후에도 자동 재전송 없음", async ({ page }) => {
  const fixture = await installPromptLab(page),
    dialog = await openRun(page);
  fixture.state.lost = true;
  await dialog.getByRole("button", { name: "실행", exact: true }).click();
  await expect(dialog.getByText("이전 작업 결과 확인 필요")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "실행", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "취소" }).click();
  await page.getByRole("button", { name: "한글 요약 검사 테스트 케이스 실행" }).click();
  await expect(dialog.getByRole("button", { name: "실행", exact: true })).toBeDisabled();
  expect(fixture.writes).toHaveLength(1);
  fixture.check();
});
test("서버 모델 변경 시 실행 전 차단", async ({ page }) => {
  const fixture = await installPromptLab(page),
    dialog = await openRun(page);
  fixture.state.testCase.models_json = '["changed-model"]';
  await dialog.getByRole("button", { name: "실행", exact: true }).click();
  await expect(dialog.getByText(/최신 내용을 조회한 뒤/)).toBeVisible();
  expect(fixture.writes).toHaveLength(0);
  fixture.check();
});
test("선택한 실험을 보관·다시 진행한 뒤 즉시 실행", async ({ page }) => {
  const fixture = await installPromptLab(page);
  await page.goto("prompts/lab?exp=public_exp_1");
  for (const label of ["보관", "다시 진행"]) {
    await page.getByRole("button", { name: `요약 품질 비교 실험 ${label}` }).click();
    const change = page.getByRole("dialog");
    await change.getByRole("button", { name: label, exact: true }).click();
    await expect(change).not.toBeVisible();
    await page.getByRole("button", { name: "한글 요약 검사 테스트 케이스 실행" }).click();
    const run = page.getByRole("dialog", { name: "테스트 케이스 실행", exact: true });
    await run.getByRole("button", { name: "실행", exact: true }).click();
    await expect(run).not.toBeVisible();
    await expect(page.getByText(/최고 점수 모델 public-model-a/)).toBeVisible();
  }
  expect(fixture.writes.filter((row) => row.path.endsWith("/run"))).toHaveLength(2);
  fixture.check();
});
test("읽기 전용·실행 이력 조회·기존 관리자 연결", async ({ page }) => {
  const fixture = await installPromptLab(page, true);
  await page.goto("prompts/lab?exp=public_exp_1");
  await expect(page.getByRole("button", { name: "한글 요약 검사 테스트 케이스 실행" })).toBeDisabled();
  await expect(page.getByRole("link", { name: /기존.*(화면|관리자)/ }).first()).toHaveAttribute(
    "href",
    /\/admin/,
  );
  await page.getByRole("button", { name: "한글 요약 검사 실행 이력" }).click();
  await expect(page.getByRole("dialog").getByText("public_run_1")).toBeVisible();
  expect(fixture.writes).toHaveLength(0);
  fixture.check();
});
test("이력 오류·재조회와 조회 권한 복구", async ({ page }) => {
  const fixture = await installPromptLab(page);
  await page.goto("prompts/lab?exp=public_exp_1");
  fixture.state.historyStatus = 500;
  await page.getByRole("button", { name: "한글 요약 검사 실행 이력" }).click();
  await expect(page.getByText("실행 이력을 불러오지 못했습니다.")).toBeVisible();
  fixture.state.historyStatus = 200;
  await page.getByRole("button", { name: "이력 새로고침" }).click();
  await expect(page.getByRole("dialog").getByText("public_run_1")).toBeVisible();
  await page.keyboard.press("Escape");
  fixture.state.readStatus = 403;
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByRole("heading", { name: "프롬프트 실험실 조회 권한 확인 필요" })).toBeVisible();
  fixture.state.readStatus = 200;
  await page.getByRole("button", { name: "권한 확인 후 다시 조회" }).click();
  await expect(page.getByText("한글 요약 검사", { exact: true })).toBeVisible();
  fixture.check();
});
test("작성 중 닫기 보호와 검색 비밀값 차단", async ({ page }) => {
  const fixture = await installPromptLab(page);
  await page.goto("prompts/lab");
  const input = page.getByRole("textbox", { name: "실험 검색" });
  await input.fill(`corp_${"x".repeat(36)}`);
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByText("비밀값이 포함된 검색어는 사용할 수 없습니다.")).toBeVisible();
  expect(page.url()).not.toContain("corp_");
  await expect(input).toBeFocused();
  await page.getByRole("button", { name: "실험 만들기" }).click();
  const dialog = page.getByRole("dialog", { name: "실험 만들기" });
  await dialog.getByRole("textbox", { name: "제목" }).fill("공개 새 실험");
  await page.keyboard.press("Escape");
  await page.getByRole("alertdialog").getByRole("button", { name: "계속 편집" }).click();
  await expect(dialog.getByRole("textbox", { name: "제목" })).toHaveValue("공개 새 실험");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(fixture.writes).toHaveLength(1);
  fixture.check();
});
for (const theme of ["light", "dark"] as const) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    test(`실험실 실행·이력 접근성 ${theme} ${viewport.width}×${viewport.height}`, async ({ page }, info) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const fixture = await installPromptLab(page),
        dialog = await openRun(page);
      await expect.poll(() => violations(page)).toEqual([]);
      await page.screenshot({ path: info.outputPath("lab-run-review.png") });
      await expect(dialog.getByRole("button", { name: "실행", exact: true })).toBeInViewport();
      await dialog.getByRole("button", { name: "취소" }).click();
      await page.getByRole("button", { name: "한글 요약 검사 실행 이력" }).click();
      await expect(page.getByRole("dialog").getByText("public_run_1")).toBeVisible();
      await expect.poll(() => violations(page)).toEqual([]);
      await page.screenshot({ path: info.outputPath("lab-history.png") });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(
        true,
      );
      fixture.check();
    });
  }
  test(`실험실 시각 기준 ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    const fixture = await installPromptLab(page),
      dialog = await openRun(page);
    await expect(dialog).toBeVisible();
    await expect(page).toHaveScreenshot(`lab-run-${theme}.png`, { animations: "disabled" });
    await dialog.getByRole("button", { name: "취소" }).click();
    await page.getByRole("button", { name: "한글 요약 검사 실행 이력" }).click();
    await expect(page.getByRole("dialog").getByText("public_run_1")).toBeVisible();
    await expect(page).toHaveScreenshot(`lab-history-${theme}.png`, { animations: "disabled" });
    fixture.check();
  });
}
