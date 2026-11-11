import { expect, test, type Page } from "@playwright/test";
import type axe from "axe-core";
import { installPromptLibrary, libraryAsset } from "../fixtures/prompt-library-browser";

async function openEditor(page: Page) {
  await page.goto("prompts/library?tab=assets");
  await page.getByRole("button", { name: "업무 요약 편집" }).click();
  return page.getByRole("dialog", { name: "프롬프트 자산 편집" });
}
async function violations(page: Page) {
  return page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
    const result = await (window as unknown as { axe: typeof axe }).axe.run(document);
    return result.violations.map((entry) => ({
      id: entry.id,
      impact: entry.impact,
      count: entry.nodes.length,
    }));
  });
}
test("자산 검색·정렬·페이지·직접 주소와 새로고침", async ({ page }) => {
  const fixture = await installPromptLibrary(page);
  fixture.state.assets = Array.from({ length: 27 }, (_, index) => ({
    ...libraryAsset,
    id: `public-${index}`,
    name: `공개 자산 ${String(index).padStart(2, "0")}`,
  }));
  await page.goto("prompts/library?tab=assets&assets_page=2&assets_sort=name&assets_direction=asc");
  await expect(page.getByRole("button", { name: "공개 자산 25 편집" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "공개 자산 25 편집" })).toBeVisible();
  await page.getByRole("textbox", { name: "이름·설명 검색" }).fill("공개 자산 00");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByRole("button", { name: "공개 자산 00 편집" })).toBeVisible();
  expect(new URL(page.url()).searchParams.has("assets_page")).toBe(false);
  fixture.check();
});
test("편집 변경 비교·부분 저장·포커스 복귀", async ({ page }) => {
  const fixture = await installPromptLibrary(page),
    dialog = await openEditor(page);
  await dialog.getByRole("textbox", { name: "이름", exact: true }).fill("업무 요약 개선");
  await dialog.getByText("이름 변경", { exact: true }).click();
  await expect(dialog.getByText("변경 전", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "업무 요약 개선 편집" })).toBeFocused();
  expect(fixture.writes).toEqual([
    { method: "PATCH", path: "/admin/templates/public-summary", body: { name: "업무 요약 개선" } },
  ]);
  fixture.check();
});
test("최신 자산 변경과 기존 ID 충돌은 저장 전에 차단", async ({ page }) => {
  const fixture = await installPromptLibrary(page),
    dialog = await openEditor(page);
  await dialog.getByRole("textbox", { name: "이름", exact: true }).fill("다른 이름");
  fixture.state.assets[0] = { ...libraryAsset, body: "외부에서 변경된 공개 본문" };
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog.getByText(/최신 내용을/)).toBeVisible();
  expect(fixture.writes).toHaveLength(0);
  await page.reload();
  await page.getByRole("button", { name: "새 자산", exact: true }).click();
  const create = page.getByRole("dialog", { name: "새 프롬프트 자산" });
  await create.getByRole("textbox", { name: "이름", exact: true }).fill("추가 요약");
  await create.getByRole("textbox", { name: "식별자 (ID)" }).fill("public-summary");
  await create.getByRole("textbox", { name: "프롬프트 본문", exact: true }).fill("공개 본문");
  await create.getByRole("button", { name: "저장", exact: true }).click();
  await expect(create.getByText(/이미 등록된 자산 ID/)).toBeVisible();
  expect(fixture.writes).toHaveLength(0);
  fixture.check();
});
test("저장 응답 유실 뒤 같은 편집 재전송 차단", async ({ page }) => {
  const fixture = await installPromptLibrary(page),
    dialog = await openEditor(page);
  await dialog.getByRole("textbox", { name: "이름", exact: true }).fill("응답 확인할 이름");
  fixture.state.lost = true;
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog.getByText("이전 작업 결과 확인 필요")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  expect(fixture.writes).toHaveLength(1);
  fixture.check();
});
test("목록 필터와 독립된 상세·버전 비교·복원", async ({ page }) => {
  const fixture = await installPromptLibrary(page);
  await page.goto("prompts/library?tab=assets&asset_q=없는이름&asset=public-summary");
  const detail = page.getByRole("dialog", { name: "업무 요약", exact: true });
  await expect(detail.getByText("플랫폼", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "v2 이전 버전과 비교" }).click();
  await expect(detail.getByLabel("v2 본문 차이")).toContainText("문서를 짧게 요약하세요.");
  await detail.getByRole("button", { name: "v1으로 복원" }).click();
  const confirm = page.getByRole("dialog", { name: "이전 버전으로 복원할까요?" });
  await expect(confirm.getByText(/이름·분류·설명·본문·태그/)).toBeVisible();
  await confirm.getByRole("button", { name: "복원", exact: true }).click();
  await expect(confirm).not.toBeVisible();
  await expect(detail.locator(".prompt-asset-body")).toHaveText("문서를 짧게 요약하세요.");
  expect(fixture.writes.at(-1)?.body).toEqual({ version: 1 });
  fixture.check();
});
test("초안 검토 제출·사유 승인·중지·삭제", async ({ page }) => {
  const fixture = await installPromptLibrary(page);
  await page.goto("prompts/library?tab=assets");
  await page.getByRole("button", { name: "업무 요약 검토 제출" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "검토 제출", exact: true }).click();
  await page.getByRole("button", { name: "업무 요약 승인" }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm.getByRole("button", { name: "승인", exact: true })).toBeDisabled();
  await confirm.getByRole("textbox", { name: /변경 사유/ }).fill("공개 검증 완료");
  await confirm.getByRole("button", { name: "승인", exact: true }).click();
  await expect(confirm).not.toBeVisible();
  await page.getByRole("switch", { name: "업무 요약 사용" }).click();
  await expect(page.getByRole("switch", { name: "업무 요약 사용" })).not.toBeChecked();
  await page.getByRole("button", { name: "업무 요약 삭제" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "삭제", exact: true }).click();
  await expect(page.getByText("등록된 프롬프트 자산이 없습니다.")).toBeVisible();
  expect(fixture.writes.map((row) => row.method)).toEqual(["POST", "POST", "PATCH", "DELETE"]);
  fixture.check();
});
test("검색 저장·불러오기·CSV 내보내기", async ({ page }) => {
  const fixture = await installPromptLibrary(page);
  await page.goto("prompts/library?tab=search");
  await page.getByRole("textbox", { name: "키워드", exact: true }).fill("요약");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await page.getByRole("textbox", { name: "저장할 이름" }).fill("요약 검색");
  await page.getByRole("button", { name: "현재 필터 저장" }).click();
  await expect(page.getByRole("textbox", { name: "저장할 이름" })).toHaveValue("");
  const filePromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 다운로드" }).click();
  expect((await filePromise).suggestedFilename()).toMatch(/^prompts-.*\.csv$/);
  await page.getByRole("button", { name: "필터 초기화" }).click();
  await page.getByRole("combobox", { name: "저장된 필터", exact: true }).selectOption("public-filter");
  await expect(page.getByRole("textbox", { name: "키워드", exact: true })).toHaveValue("요약");
  expect(fixture.writes).toHaveLength(1);
  fixture.check();
});
test("읽기 전용·조회 권한 오류·명시적 재조회", async ({ page }) => {
  const fixture = await installPromptLibrary(page, true);
  await page.goto("prompts/library?tab=assets&asset=public-summary");
  await expect(page.getByRole("button", { name: "복사 및 사용 기록 요청" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "본문 복사" })).toBeEnabled();
  await page.keyboard.press("Escape");
  fixture.state.readStatus = 403;
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByRole("heading", { name: "프롬프트 보관함 조회 권한 확인 필요" })).toBeVisible();
  fixture.state.readStatus = 200;
  await page.getByRole("button", { name: "권한 확인 후 다시 조회" }).click();
  await expect(page.getByRole("button", { name: "업무 요약 편집" })).toBeDisabled();
  expect(fixture.writes).toHaveLength(0);
  fixture.check();
});
for (const theme of ["light", "dark"] as const) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    test(`보관함 편집·상세 접근성 ${theme} ${viewport.width}×${viewport.height}`, async ({ page }, info) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      const fixture = await installPromptLibrary(page),
        editor = await openEditor(page);
      await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
      await expect.poll(() => violations(page)).toEqual([]);
      await expect(editor.getByRole("button", { name: "취소" })).toBeInViewport();
      await page.screenshot({ path: info.outputPath("library-editor.png") });
      await editor.getByRole("button", { name: "취소" }).click();
      await page.getByRole("button", { name: "업무 요약", exact: true }).click();
      await expect(page.getByRole("dialog").getByText("플랫폼", { exact: true })).toBeVisible();
      expect(
        await page
          .locator(".sheet-body")
          .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      await expect.poll(() => violations(page)).toEqual([]);
      await page.screenshot({ path: info.outputPath("library-detail.png") });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(
        true,
      );
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "업무 요약", exact: true })).toBeFocused();
      fixture.check();
    });
  }
  test(`보관함 시각 기준 ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    const fixture = await installPromptLibrary(page),
      editor = await openEditor(page);
    await expect(editor).toHaveScreenshot(`library-editor-${theme}.png`, { animations: "disabled" });
    await editor.getByRole("button", { name: "취소" }).click();
    await page.getByRole("button", { name: "업무 요약", exact: true }).click();
    const detail = page.getByRole("dialog", { name: "업무 요약", exact: true });
    await expect(detail.getByText("플랫폼", { exact: true })).toBeVisible();
    await expect(detail).toHaveScreenshot(`library-detail-${theme}.png`, { animations: "disabled" });
    fixture.check();
  });
}
