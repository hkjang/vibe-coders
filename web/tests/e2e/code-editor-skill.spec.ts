import { expect, type Page } from "@playwright/test";
import type axe from "axe-core";
import { firstEmail, targetUrl, test } from "../fixtures/skill-fitness-gateway";
import {
  activateEditor,
  refreshRuntime,
  replaceCode,
  watchEditorAssets,
} from "../fixtures/agent-code-editor";

const label = "실행 지침";
const draft = "  첫 번째 한글 지침\n  - 두 번째 단계  \n";
const candidate = {
  id: "public-candidate",
  title: "공개 스킬 후보",
  suggested_name: "public-new-skill",
  source: "public-source",
  suggested: { instructions: "후보 지침" },
};
async function open(page: Page, adopt = false) {
  const assets = await watchEditorAssets(page);
  await page.route("**/admin/skill-studio/candidates?*", (route) =>
    route.fulfill({ json: { candidates: [candidate] } }),
  );
  await page.goto(`login?return_to=${encodeURIComponent(targetUrl)}`);
  await page.getByLabel("이메일", { exact: true }).fill(firstEmail);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  if (adopt) {
    await page.getByRole("tab", { name: "스튜디오", exact: true }).click();
    await page.getByRole("button", { name: `${candidate.title} 채택하기`, exact: true }).click();
  } else await page.getByRole("button", { name: "스킬 추가", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: adopt ? "후보를 스킬로 채택" : "스킬 추가", exact: true });
  if (!adopt) await dialog.getByRole("textbox", { name: "이름", exact: true }).fill("public-new-skill");
  assets.expectDeferred();
  return dialog;
}

for (const adopt of [false, true])
  test(`${adopt ? "후보 채택" : "스킬 등록"}의 지침을 왕복 편집하고 기존 공백 처리로 한 번 저장한다`, async ({
    page,
    gateway,
  }) => {
    const writes: Record<string, unknown>[] = [];
    const path = adopt ? "/admin/skill-studio/adopt" : "/admin/skills";
    await page.route(`**${path}`, (route) => {
      if (route.request().method() === "GET") return route.fallback();
      const body = route.request().postDataJSON() as Record<string, unknown>;
      writes.push(body);
      return route.fulfill({ json: { skill: { ...body, status: "draft" } } });
    });
    const dialog = await open(page, adopt);
    const editor = await activateEditor(dialog, label);
    await replaceCode(editor, draft);
    await editor.getByRole("button", { name: `${label} 기본 입력으로 전환`, exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: label, exact: true })).toHaveValue(draft);
    await activateEditor(dialog, label);
    await dialog.getByRole("button", { name: adopt ? "초안으로 채택" : "스킬 만들기", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.instructions).toBe(adopt ? draft.trim() : draft);
    if (adopt) expect(writes[0]?.source).toBe(candidate.source);
    expect(gateway.unexpected).toEqual([]);
  });

for (const colorScheme of ["light", "dark"] as const)
  test(`스킬 지침 ${colorScheme} 좁은 화면에서 읽기 전용 전환과 초안 보호`, async ({
    page,
    gateway,
  }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
    const dialog = await open(page);
    const editor = await activateEditor(dialog, label);
    await replaceCode(editor, draft);
    gateway.setReadOnly(true);
    await refreshRuntime(page);
    await expect(editor.locator("textarea.inputarea")).not.toBeEditable();
    await expect(dialog.getByRole("button", { name: "스킬 만들기", exact: true })).toBeDisabled();
    await dialog.locator("form").evaluate((form) => (form as HTMLFormElement).requestSubmit());
    await expect(dialog.getByRole("heading", { name: "스킬 추가", exact: true })).toBeInViewport();
    await expect(dialog.getByRole("button", { name: "취소", exact: true })).toBeInViewport();
    const scrollHint = dialog.getByText("지침과 실행 정책을 위아래로 스크롤해 확인할 수 있습니다.", {
      exact: true,
    });
    await scrollHint.focus();
    await expect(scrollHint).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(
      await page.evaluate(async () =>
        (await (window as unknown as { axe: typeof axe }).axe.run(document)).violations.map((v) => v.id),
      ),
    ).toEqual([]);
    await page.screenshot({ path: info.outputPath(`skill-code-${colorScheme}.png`) });
    await dialog.getByRole("button", { name: "취소", exact: true }).click();
    await expect(page.getByRole("alertdialog", { name: "저장하지 않은 변경사항이 있습니다" })).toBeVisible();
    await page.getByRole("button", { name: "계속 편집", exact: true }).click();
    gateway.setReadOnly(false);
    await refreshRuntime(page);
    await editor.getByRole("button", { name: `${label} 기본 입력으로 전환`, exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: label, exact: true })).toHaveValue(draft);
    expect(gateway.writes).toEqual([]);
    expect(gateway.unexpected).toEqual([]);
  });

test("후보 채택의 빈 지침 검증은 코드 입력으로 초점을 돌린다", async ({ page, gateway }) => {
  const dialog = await open(page, true);
  const editor = await activateEditor(dialog, label);
  await replaceCode(editor, "");
  await dialog.getByRole("button", { name: "초안으로 채택", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(editor.locator("textarea.inputarea")).toBeFocused();
  await expect(editor.locator("textarea.inputarea")).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByText("지침을 입력하세요.", { exact: true })).toBeVisible();
  expect(gateway.unexpected).toEqual([]);
});
