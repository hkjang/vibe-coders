import { expect, type Page } from "@playwright/test";
import type axe from "axe-core";
import { first, test } from "../fixtures/workflow-ownership-gateway";
import {
  activateEditor,
  refreshRuntime,
  replaceCode,
  watchEditorAssets,
} from "../fixtures/agent-code-editor";

const label = "단계 정의 (JSON 배열)";
const draft = '[\n  {"name":"한글 검토","type":"approval","note":"공개 초안"}\n]';
async function edit(page: Page) {
  const assets = await watchEditorAssets(page);
  await page.goto("agents/workflows");
  await page.getByRole("button", { name: `${first.name} 상세 열기`, exact: true }).click();
  await page
    .getByRole("dialog", { name: first.name, exact: true })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "워크플로 수정", exact: true });
  await dialog.getByRole("button", { name: "JSON으로 편집", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: label, exact: true })).toBeVisible();
  assets.expectDeferred();
  return dialog;
}

test("워크플로 단계·JSON·코드 편집을 왕복하고 현재 단계를 한 번 저장한다", async ({ page, gateway }) => {
  const writes: unknown[] = [];
  await page.route("**/admin/workflows", (route) => {
    if (route.request().method() === "GET") return route.fallback();
    writes.push(route.request().postDataJSON());
    return route.fulfill({ json: first });
  });
  const dialog = await edit(page);
  const editor = await activateEditor(dialog, label);
  await replaceCode(editor, draft);
  await dialog.getByRole("button", { name: "단계 편집기로 돌아가기", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "1번째 단계 이름", exact: true })).toHaveValue(
    "한글 검토",
  );
  await dialog.getByRole("button", { name: "JSON으로 편집", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: label, exact: true })).toHaveValue(draft);
  await activateEditor(dialog, label);
  await dialog.getByRole("button", { name: "수정 저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(writes).toEqual([expect.objectContaining({ id: first.id, steps: JSON.parse(draft) })]);
  expect(gateway.unexpected).toEqual([]);
});

test("워크플로의 잘못된 JSON은 코드 입력에 초점을 돌리고 미저장 초안을 보호한다", async ({
  page,
  gateway,
}) => {
  const dialog = await edit(page);
  const editor = await activateEditor(dialog, label);
  await replaceCode(editor, "[공개 오류");
  await dialog.getByRole("button", { name: "수정 저장", exact: true }).focus();
  await page.keyboard.press("Enter");
  const input = editor.locator("textarea.inputarea");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByText("단계 정의가 올바른 JSON이 아닙니다.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByRole("alertdialog", { name: "저장하지 않은 변경사항이 있습니다" })).toBeVisible();
  await page.getByRole("button", { name: "계속 편집", exact: true }).click();
  await editor.getByRole("button", { name: `${label} 기본 입력으로 전환`, exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: label, exact: true })).toHaveValue("[공개 오류");
  expect(gateway.writes).toEqual([]);
});

test("워크플로 코드 편집기 자산 실패에도 기본 입력으로 유효한 초안을 유지한다", async ({ page, gateway }) => {
  const dialog = await edit(page);
  await dialog.getByRole("textbox", { name: label, exact: true }).fill(draft);
  await page.route(/\/app\/assets\/MonacoEditor-[^/]+\.js$/u, (route) => route.abort("failed"));
  await dialog.getByRole("button", { name: `${label} 코드 편집기 열기`, exact: true }).click();
  await expect(
    dialog.getByText("코드 편집기를 사용할 수 없어 기본 입력을 표시합니다. 입력 내용은 유지됩니다."),
  ).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: label, exact: true })).toHaveValue(draft);
  expect(gateway.writes).toEqual([]);
});

for (const colorScheme of ["light", "dark"] as const)
  test(`워크플로 ${colorScheme} 좁은 화면의 코드 편집 초안을 읽기 전용 전환 뒤 유지한다`, async ({
    page,
    gateway,
  }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
    const dialog = await edit(page);
    const editor = await activateEditor(dialog, label);
    await replaceCode(editor, draft);
    gateway.setMode("preview_read_only");
    await refreshRuntime(page);
    await expect(editor.locator("textarea.inputarea")).not.toBeEditable();
    await expect(dialog.getByRole("button", { name: "수정 저장", exact: true })).toBeDisabled();
    await dialog.locator("form").evaluate((form) => (form as HTMLFormElement).requestSubmit());
    expect(gateway.writes).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(dialog.getByRole("button", { name: "취소", exact: true })).toBeInViewport();
    await expect(dialog.getByRole("heading", { name: "워크플로 수정", exact: true })).toBeInViewport();
    const scrollHint = dialog.getByText("단계 정의는 위아래로 스크롤해 확인할 수 있습니다.", { exact: true });
    await scrollHint.focus();
    await expect(scrollHint).toBeFocused();
    const violations = await page.evaluate(async () =>
      (await (window as unknown as { axe: typeof axe }).axe.run(document)).violations.map((v) => v.id),
    );
    expect(violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`workflow-code-${colorScheme}.png`) });
    gateway.setMode("writable");
    await refreshRuntime(page);
    await editor.getByRole("button", { name: `${label} 기본 입력으로 전환`, exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: label, exact: true })).toHaveValue(draft);
  });
