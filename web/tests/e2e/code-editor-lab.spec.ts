import { expect, test, type Page } from "@playwright/test";
import type axe from "axe-core";
import { installPromptLab } from "../fixtures/prompt-lab-browser";
import {
  activateEditor,
  refreshRuntime,
  replaceCode,
  watchEditorAssets,
} from "../fixtures/agent-code-editor";

async function open(page: Page, kind: "contract" | "rubric" | "case") {
  const fixture = await installPromptLab(page);
  const assets = await watchEditorAssets(page);
  await page.goto(
    kind === "case"
      ? "prompts/lab?exp=public_exp_1"
      : `prompts/lab?tab=${kind === "contract" ? "contracts" : "rubrics"}`,
  );
  const title =
    kind === "contract" ? "출력 계약 추가" : kind === "rubric" ? "평가 기준 추가" : "테스트 케이스 추가";
  await page.getByRole("button", { name: kind === "contract" ? "계약 추가" : title, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await dialog.getByRole("textbox", { name: "이름", exact: true }).fill("공개 검사");
  assets.expectDeferred();
  return { ...fixture, dialog };
}

test("출력 계약의 JSON·정규식 전환은 입력을 보존하고 JSON 정렬을 구분한다", async ({ page }) => {
  const f = await open(page, "contract");
  await f.dialog.getByRole("combobox", { name: "유형", exact: true }).selectOption("json_schema");
  const editor = await activateEditor(f.dialog, "스키마 / 정규식");
  await replaceCode(editor, '{"required":["summary"]}');
  await expect(editor.getByRole("button", { name: "JSON 들여쓰기 정리", exact: true })).toBeVisible();
  await f.dialog.getByRole("combobox", { name: "유형", exact: true }).selectOption("regex");
  await expect(editor.getByRole("button", { name: "JSON 들여쓰기 정리", exact: true })).toHaveCount(0);
  await editor.getByRole("button", { name: "스키마 / 정규식 기본 입력으로 전환", exact: true }).click();
  await expect(f.dialog.getByRole("textbox", { name: "스키마 / 정규식", exact: true })).toHaveValue(
    '{"required":["summary"]}',
  );
  await activateEditor(f.dialog, "스키마 / 정규식");
  await replaceCode(editor, "  ^공개\\s+검사$  ");
  await editor.getByRole("button", { name: "스키마 / 정규식 기본 입력으로 전환", exact: true }).click();
  await expect(f.dialog.getByRole("textbox", { name: "스키마 / 정규식", exact: true })).toHaveValue(
    "  ^공개\\s+검사$  ",
  );
  await f.dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(f.dialog).toBeHidden();
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]?.body).toMatchObject({ type: "regex", schema_json: "^공개\\s+검사$" });
  f.check();
});

test("평가 기준의 업무 JSON 검증은 코드 입력으로 초점을 돌리고 수정 뒤 저장한다", async ({ page }) => {
  const f = await open(page, "rubric");
  const editor = await activateEditor(f.dialog, "기준(JSON)");
  await replaceCode(editor, '{"accuracy":');
  await f.dialog.getByRole("button", { name: "저장", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(editor.locator("textarea.inputarea")).toBeFocused();
  await expect(editor.locator("textarea.inputarea")).toHaveAttribute("aria-invalid", "true");
  expect(f.writes).toEqual([]);
  await replaceCode(editor, '  {"accuracy":0.4}  ');
  await f.dialog.getByRole("button", { name: "저장", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(f.dialog).toBeHidden();
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]?.body).toMatchObject({ criteria: { accuracy: 0.4 } });
  f.check();
});

test("검사 프롬프트 두 입력은 권한 전환 뒤 유지되고 기존 공백 규칙으로 저장된다", async ({ page }) => {
  const f = await open(page, "case");
  const system = "  시스템 한글\n  지침  ",
    user = "  사용자 한글\n  질문  ";
  const systemEditor = await activateEditor(f.dialog, "시스템 프롬프트");
  await replaceCode(systemEditor, system);
  const userEditor = await activateEditor(f.dialog, "사용자 프롬프트");
  await replaceCode(userEditor, user);
  const feature = f.bootstrap.migration_registry[0];
  if (!feature) throw new Error("missing public feature");
  feature.read_only = true;
  await refreshRuntime(page);
  await expect(systemEditor.locator("textarea.inputarea")).not.toBeEditable();
  await expect(userEditor.locator("textarea.inputarea")).not.toBeEditable();
  await f.dialog.locator("form").evaluate((form) => (form as HTMLFormElement).requestSubmit());
  expect(f.writes).toEqual([]);
  feature.read_only = false;
  await refreshRuntime(page);
  await f.dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(f.dialog).toBeHidden();
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]?.body).toMatchObject({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user.trim() },
    ],
    experiment_id: "public_exp_1",
  });
  f.check();
});

for (const colorScheme of ["light", "dark"] as const)
  test(`실험 편집기 ${colorScheme} 좁은 화면의 초안 보호·키보드·접근성`, async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
    const f = await open(page, "case");
    const editor = await activateEditor(f.dialog, "사용자 프롬프트");
    await replaceCode(editor, "유지할 공개 초안");
    await expect(f.dialog.getByRole("heading", { name: "테스트 케이스 추가", exact: true })).toBeInViewport();
    await expect(f.dialog.getByRole("button", { name: "저장", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(
      await page.evaluate(async () =>
        (await (window as unknown as { axe: typeof axe }).axe.run(document)).violations.map((v) => v.id),
      ),
    ).toEqual([]);
    await page.screenshot({ path: info.outputPath(`lab-code-${colorScheme}.png`) });
    await f.dialog.getByRole("button", { name: "취소", exact: true }).click();
    await expect(page.getByRole("alertdialog", { name: "저장하지 않은 변경사항이 있습니다" })).toBeVisible();
    await page.getByRole("button", { name: "계속 편집", exact: true }).click();
    await editor.getByRole("button", { name: "사용자 프롬프트 기본 입력으로 전환", exact: true }).click();
    await expect(f.dialog.getByRole("textbox", { name: "사용자 프롬프트", exact: true })).toHaveValue(
      "유지할 공개 초안",
    );
    expect(f.writes).toEqual([]);
    f.check();
  });
