import { expect, test, type Page } from "@playwright/test";
import { installPromptLibrary, libraryAsset } from "../fixtures/prompt-library-browser";
import {
  activateEditor,
  refreshRuntime,
  replaceCode,
  watchEditorAssets,
} from "../fixtures/agent-code-editor";

async function edit(page: Page) {
  const fixture = await installPromptLibrary(page);
  const assets = await watchEditorAssets(page);
  await page.goto("prompts/library?tab=assets");
  await page.getByRole("button", { name: "업무 요약 편집", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "프롬프트 자산 편집", exact: true });
  assets.expectDeferred();
  return { ...fixture, dialog };
}
const label = "프롬프트 본문";
const draft = "  한글 자산 본문\n  - 공백과 줄바꿈 유지  ";

test("자산 코드 본문은 왕복·변경 비교 뒤 기존 부분 수정으로 한 번 저장된다", async ({ page }) => {
  const f = await edit(page);
  const editor = await activateEditor(f.dialog, label);
  await replaceCode(editor, draft);
  await editor.getByRole("button", { name: `${label} 기본 입력으로 전환`, exact: true }).click();
  await expect(f.dialog.getByRole("textbox", { name: label, exact: true })).toHaveValue(draft);
  await activateEditor(f.dialog, label);
  await f.dialog.getByText("본문 변경", { exact: true }).click();
  await expect(f.dialog.getByText("변경 전", { exact: true })).toBeVisible();
  await f.dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(f.dialog).toBeHidden();
  expect(f.writes).toEqual([
    { method: "PATCH", path: `/admin/templates/${libraryAsset.id}`, body: { body: draft.trim() } },
  ]);
  f.check();
});

test("자산 읽기 전용 전환과 저장 응답 유실은 코드 초안을 잠그고 재전송을 막는다", async ({ page }) => {
  const f = await edit(page);
  const editor = await activateEditor(f.dialog, label);
  await replaceCode(editor, draft);
  const feature = f.bootstrap.migration_registry[0];
  if (!feature) throw new Error("missing public feature");
  feature.read_only = true;
  await refreshRuntime(page);
  await expect(editor.locator("textarea.inputarea")).not.toBeEditable();
  await f.dialog.locator("form").evaluate((form) => (form as HTMLFormElement).requestSubmit());
  expect(f.writes).toEqual([]);
  feature.read_only = false;
  await refreshRuntime(page);
  await expect(editor.locator("textarea.inputarea")).toBeEditable();
  f.state.lost = true;
  await f.dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(f.dialog.getByText("이전 작업 결과 확인 필요", { exact: true })).toBeVisible();
  await expect(editor.locator("textarea.inputarea")).not.toBeEditable();
  await f.dialog.locator("form").evaluate((form) => (form as HTMLFormElement).requestSubmit());
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]?.body).toEqual({ body: draft.trim() });
  f.check();
});
