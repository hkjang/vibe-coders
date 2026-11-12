import { expect, type Page } from "@playwright/test";
import { alpha, firstEmail, targetUrl, test } from "../fixtures/app-permission-gateway";
import {
  activateEditor,
  refreshRuntime,
  replaceCode,
  watchEditorAssets,
} from "../fixtures/agent-code-editor";

const label = "구성 요소 (JSON 배열)";
const draft = '[\n  {"kind":"model","ref":"public-model","label":"한글 추천 모델"}\n]';
async function edit(page: Page) {
  const assets = await watchEditorAssets(page);
  await page.goto(`login?return_to=${encodeURIComponent(targetUrl)}`);
  await page.getByLabel("이메일", { exact: true }).fill(firstEmail);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await page.getByRole("button", { name: `${alpha.title} 상세 열기`, exact: true }).click();
  await page
    .getByRole("dialog", { name: alpha.title, exact: true })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "AI 업무 앱 수정", exact: true });
  await expect(dialog.getByRole("textbox", { name: label, exact: true })).toBeVisible();
  assets.expectDeferred();
  return dialog;
}

test("앱 JSON 변경은 이전 검토를 취소하고 편집 모드 왕복 뒤 확인한 구성만 저장한다", async ({
  page,
  gateway,
}) => {
  const writes: unknown[] = [];
  await page.route(`**/admin/apps/${alpha.id}`, (route) => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ json: alpha });
  });
  const dialog = await edit(page);
  const review = dialog.getByRole("button", { name: "변경 내용 검토", exact: true });
  const confirmation = dialog.getByRole("checkbox", {
    name: "변경 내용과 적용 범위를 확인했습니다.",
    exact: true,
  });
  await review.click();
  await confirmation.check();
  const editor = await activateEditor(dialog, label);
  await replaceCode(editor, draft);
  await expect(dialog.getByRole("button", { name: "수정 저장", exact: true })).toBeDisabled();
  await expect(confirmation).toHaveCount(0);
  await editor.getByRole("button", { name: `${label} 기본 입력으로 전환`, exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: label, exact: true })).toHaveValue(draft);
  await activateEditor(dialog, label);
  await review.click();
  await confirmation.check();
  await dialog.getByRole("button", { name: "수정 저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(writes).toEqual([
    expect.objectContaining({ components: JSON.parse(draft), allowed_teams: alpha.allowed_teams }),
  ]);
  expect(gateway.unexpected).toEqual([]);
});

test("앱 JSON 검증 오류는 코드 편집기로 초점을 돌리고 예시 입력은 이전 실행 취소를 지운다", async ({
  page,
  gateway,
}) => {
  const dialog = await edit(page);
  const editor = await activateEditor(dialog, label);
  await replaceCode(editor, "[공개 오류");
  await dialog.getByRole("button", { name: "변경 내용 검토", exact: true }).focus();
  await page.keyboard.press("Enter");
  const input = editor.locator("textarea.inputarea");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByText("구성 요소가 올바른 JSON이 아닙니다.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "예시 채우기", exact: true }).click();
  await editor.getByRole("button", { name: "입력 되돌리기", exact: true }).click();
  await editor.getByRole("button", { name: `${label} 기본 입력으로 전환`, exact: true }).click();
  const value = await dialog.getByRole("textbox", { name: label, exact: true }).inputValue();
  expect(JSON.parse(value)).toHaveLength(2);
  expect(value).not.toContain("공개 오류");
  expect(gateway.writes).toEqual([]);
});

test("앱 코드 편집 중 권한 전환은 초안을 유지하고 직접 제출을 막는다", async ({ page, gateway }) => {
  const dialog = await edit(page);
  const editor = await activateEditor(dialog, label);
  await replaceCode(editor, draft);
  await dialog.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
  await dialog.getByRole("checkbox", { name: "변경 내용과 적용 범위를 확인했습니다.", exact: true }).check();
  await expect(dialog.getByRole("button", { name: "수정 저장", exact: true })).toBeEnabled();
  gateway.setReadOnly(true);
  await refreshRuntime(page);
  await expect(editor.locator("textarea.inputarea")).not.toBeEditable();
  await expect(editor.getByRole("button", { name: "JSON 들여쓰기 정리", exact: true })).toBeDisabled();
  await dialog.locator("form").evaluate((form) => (form as HTMLFormElement).requestSubmit());
  expect(gateway.writes).toEqual([]);
  gateway.setReadOnly(false);
  await refreshRuntime(page);
  await editor.getByRole("button", { name: `${label} 기본 입력으로 전환`, exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: label, exact: true })).toHaveValue(draft);
});

test("앱 저장 대기 중에는 코드 편집과 중복 제출을 막고 실패 뒤 초안을 복원한다", async ({
  page,
  gateway,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  await page.route(`**/admin/apps/${alpha.id}`, async (route) => {
    writes++;
    await pending;
    return route.fulfill({ status: 503, json: { error: { message: "public failure" } } });
  });
  try {
    const dialog = await edit(page);
    const editor = await activateEditor(dialog, label);
    await replaceCode(editor, draft);
    await dialog.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
    await dialog
      .getByRole("checkbox", { name: "변경 내용과 적용 범위를 확인했습니다.", exact: true })
      .check();
    await dialog.getByRole("button", { name: "수정 저장", exact: true }).click();
    await expect.poll(() => writes).toBe(1);
    await expect(editor.locator("textarea.inputarea")).not.toBeEditable();
    await dialog.locator("form").evaluate((form) => (form as HTMLFormElement).requestSubmit());
    expect(writes).toBe(1);
    release();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(editor.locator("textarea.inputarea")).toBeEditable();
    await editor.getByRole("button", { name: `${label} 기본 입력으로 전환`, exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: label, exact: true })).toHaveValue(draft);
    expect(gateway.unexpected).toEqual([]);
  } finally {
    release();
  }
});
