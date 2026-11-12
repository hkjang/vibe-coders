import { expect, test } from "@playwright/test";
import { installDefinitionEditor } from "../fixtures/golden-definition-browser";
import {
  activateEditor,
  refreshRuntime,
  replaceCode,
  watchEditorAssets,
} from "../fixtures/agent-code-editor";
import type { Locator, Page } from "@playwright/test";

async function edit(page: Page) {
  const fixture = await installDefinitionEditor(page);
  const assets = await watchEditorAssets(page);
  await page.goto("prompts/regression?tab=workflows&selection=public-workflow-a");
  await page.getByRole("button", { name: "정의 편집", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "검증 워크플로 편집", exact: true });
  await expect(dialog.getByRole("textbox", { name: "1단계 검사 프롬프트", exact: true })).toBeVisible();
  assets.expectDeferred();
  return { ...fixture, dialog };
}
async function approve(dialog: Locator) {
  await dialog.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
  await dialog
    .getByRole("checkbox", { name: "변경 내용과 다음 검사에 반영될 범위를 확인했습니다.", exact: true })
    .check();
}

test("열린 단계 편집기를 이동해도 프롬프트·기대 내용·출처가 같은 단계에 남는다", async ({ page }) => {
  const f = await edit(page);
  const prompt = "  한글 검사\n  두 번째 줄  ";
  const expected = " 한글 기대\n  공백 유지  ";
  await replaceCode(await activateEditor(f.dialog, "1단계 검사 프롬프트"), prompt);
  await replaceCode(await activateEditor(f.dialog, "1단계 기대 내용"), expected);
  await f.dialog.getByRole("button", { name: "1단계 아래로 이동", exact: true }).click();
  for (const [label, value] of [
    ["2단계 검사 프롬프트", prompt],
    ["2단계 기대 내용", expected],
  ]) {
    await f.dialog.getByRole("button", { name: `${label} 기본 입력으로 전환`, exact: true }).click();
    await expect(f.dialog.getByRole("textbox", { name: label, exact: true })).toHaveValue(value);
  }
  await expect(f.dialog.getByRole("textbox", { name: "1단계 검사 프롬프트", exact: true })).toHaveValue(
    "두 번째 질문",
  );
  await approve(f.dialog);
  await f.dialog.getByRole("button", { name: "수정 저장", exact: true }).click();
  await expect(f.dialog).toBeHidden();
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]?.body.steps).toEqual([
    expect.objectContaining({ prompt: "두 번째 질문", expected: "두 번째 답변" }),
    expect.objectContaining({
      prompt: prompt.trim(),
      expected,
      source_run_id: "public-source",
      baseline_score: 82.5,
    }),
  ]);
  f.check();
});

test("편집한 단계 삭제 뒤 새 단계에 이전 내용이 남지 않고 오류 초점을 유지한다", async ({ page }) => {
  const f = await edit(page);
  await replaceCode(await activateEditor(f.dialog, "1단계 검사 프롬프트"), "삭제할 공개 초안");
  await f.dialog.getByRole("button", { name: "1단계 삭제", exact: true }).click();
  await expect(f.dialog.locator(".monaco-editor")).toHaveCount(0);
  await expect(f.dialog.getByRole("textbox", { name: "1단계 검사 프롬프트", exact: true })).toHaveValue(
    "두 번째 질문",
  );
  await f.dialog.getByRole("button", { name: "검증 단계 추가", exact: true }).click();
  await expect(f.dialog.getByRole("textbox", { name: "2단계 이름", exact: true })).toBeFocused();
  const editor = await activateEditor(f.dialog, "2단계 검사 프롬프트");
  await f.dialog.getByRole("button", { name: "변경 내용 검토", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(editor.locator("textarea.inputarea")).toBeFocused();
  await expect(editor.locator("textarea.inputarea")).toHaveAttribute("aria-invalid", "true");
  await editor.getByRole("button", { name: "2단계 검사 프롬프트 기본 입력으로 전환", exact: true }).click();
  await expect(f.dialog.getByRole("textbox", { name: "2단계 검사 프롬프트", exact: true })).toHaveValue("");
  expect(f.writes).toEqual([]);
  f.check();
});

test("검증 정의의 읽기 전용 전환은 열린 편집기와 제출을 잠그고 초안을 유지한다", async ({ page }) => {
  const f = await edit(page);
  const editor = await activateEditor(f.dialog, "1단계 검사 프롬프트");
  await replaceCode(editor, "복구할 공개 초안");
  await approve(f.dialog);
  const feature = f.bootstrap.migration_registry[0];
  if (!feature) throw new Error("missing fixture feature");
  feature.read_only = true;
  await refreshRuntime(page);
  await expect(editor.locator("textarea.inputarea")).not.toBeEditable();
  await expect(f.dialog.getByRole("button", { name: "수정 저장", exact: true })).toBeDisabled();
  await f.dialog.locator("form").evaluate((form) => (form as HTMLFormElement).requestSubmit());
  expect(f.writes).toEqual([]);
  feature.read_only = false;
  await refreshRuntime(page);
  await editor.getByRole("button", { name: "1단계 검사 프롬프트 기본 입력으로 전환", exact: true }).click();
  await expect(f.dialog.getByRole("textbox", { name: "1단계 검사 프롬프트", exact: true })).toHaveValue(
    "복구할 공개 초안",
  );
  f.check();
});

test("검증 단계 저장 응답을 잃으면 코드 초안을 잠그고 재전송 없이 현재 정의를 확인한다", async ({ page }) => {
  const f = await edit(page);
  const editor = await activateEditor(f.dialog, "1단계 검사 프롬프트");
  await replaceCode(editor, "전송한 공개 검사");
  await approve(f.dialog);
  f.state.lostResponse = true;
  await f.dialog.getByRole("button", { name: "수정 저장", exact: true }).click();
  await expect(f.dialog.getByRole("button", { name: "저장 결과 확인", exact: true })).toBeEnabled();
  await expect(editor.locator("textarea.inputarea")).not.toBeEditable();
  await f.dialog.getByRole("button", { name: "저장 결과 확인", exact: true }).click();
  await expect(f.dialog).toBeHidden();
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]?.body.steps).toEqual([
    expect.objectContaining({ prompt: "전송한 공개 검사", source_run_id: "public-source" }),
    expect.objectContaining({ prompt: "두 번째 질문" }),
  ]);
  f.check();
});
