import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type axe from "axe-core";
import { installDefinitionEditor } from "../fixtures/golden-definition-browser";
import { test as sqlTest, account as sqlAccount } from "./fixtures/text2sql-emergency";

// Use the Go server's current policy even when CI serves assets through Vite.
const headers = readFileSync(new URL("../../../internal/appui/headers.go", import.meta.url), "utf8");
const policyMatch = headers.match(/const appContentSecurityPolicy = ("[^\n]+")/u)?.[1];
if (!policyMatch) throw new Error("Go application CSP is missing");
const csp = JSON.parse(policyMatch) as string;

async function setup(page: Page) {
  const fixture = await installDefinitionEditor(page);
  const assets: string[] = [],
    workers: string[] = [],
    external: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/app/assets/")) assets.push(url.pathname);
    if (page.url().startsWith("http") && url.origin !== new URL(page.url()).origin) external.push(url.origin);
  });
  page.on("worker", (worker) => workers.push(worker.url()));
  await page.route("**/app/**", async (route) => {
    if (!route.request().isNavigationRequest()) return route.fallback();
    const response = await route.fetch();
    return route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": csp } });
  });
  await page.goto("prompts/regression");
  await page.getByRole("button", { name: "기준 프롬프트 추가", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "기준 프롬프트 추가", exact: true });
  await dialog.getByRole("textbox", { name: "이름", exact: true }).fill("공개 편집기 검증");
  return { ...fixture, dialog, assets, workers, external };
}
const field = (dialog: Locator, label: string) =>
  dialog
    .locator(".code-editor")
    .filter({ has: dialog.page().getByRole("button", { name: `${label} 코드 편집기 열기`, exact: true }) });
async function activate(dialog: Locator, label: string) {
  const container = field(dialog, label);
  await container.getByRole("button", { name: `${label} 코드 편집기 열기`, exact: true }).click();
  const editor = dialog
    .locator(".code-editor")
    .filter({ has: dialog.page().getByRole("button", { name: `${label} 기본 입력으로 전환`, exact: true }) });
  await expect(editor.locator(".monaco-editor")).toBeVisible();
  await expect(editor.locator("textarea.inputarea")).toBeFocused();
  return editor;
}
async function replace(page: Page, editor: Locator, value: string) {
  await editor.locator("textarea.inputarea").focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(value);
}
async function basic(editor: Locator, label: string) {
  await editor.getByRole("button", { name: `${label} 기본 입력으로 전환`, exact: true }).click();
}

test("명시적 활성화 전에는 편집기를 받지 않고 한글·줄바꿈·공백을 왕복해 그대로 검토·저장한다", async ({
  page,
}) => {
  const fixture = await setup(page);
  const { dialog } = fixture;
  const draft = "첫 줄\n  한글 질문\n공개 편집기 검사  끝  ";
  await dialog.getByRole("textbox", { name: "기준 프롬프트", exact: true }).fill(draft);
  expect(fixture.assets.some((path) => /MonacoEditor|jsonMode|\.worker-/u.test(path))).toBe(false);
  let editor = await activate(dialog, "기준 프롬프트");
  await basic(editor, "기준 프롬프트");
  await expect(dialog.getByRole("textbox", { name: "기준 프롬프트", exact: true })).toHaveValue(draft);
  editor = await activate(dialog, "기준 프롬프트");
  await replace(page, editor, draft + "수정");
  await basic(editor, "기준 프롬프트");
  await expect(dialog.getByRole("textbox", { name: "기준 프롬프트", exact: true })).toBeFocused();
  await expect(dialog.getByRole("textbox", { name: "기준 프롬프트", exact: true })).toHaveValue(
    draft + "수정",
  );
  await dialog.getByRole("button", { name: "변경 내용 검토" }).click();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "정의 등록", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(fixture.writes[0]?.body.prompt).toBe(draft + "수정");
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(
    "공개 편집기 검사",
  );
  fixture.check();
});

test("JSON 작업자는 로컬에서 형식을 정리하며 외부 스키마를 요청하지 않고 큰 정수 원문을 보존한다", async ({
  page,
}) => {
  const fixture = await setup(page),
    label = "태그 (JSON 문자열 배열)";
  const editor = await activate(fixture.dialog, label);
  const text =
    '{"$schema":"https://example.invalid/private-schema.json","값":9007199254740993,"text":"<img src=x onerror=alert(1)>"}';
  await replace(page, editor, text);
  await editor.getByRole("button", { name: "JSON 들여쓰기 정리", exact: true }).click();
  await expect(editor.getByRole("button", { name: "JSON 들여쓰기 정리", exact: true })).toBeEnabled();
  await basic(editor, label);
  const result = await fixture.dialog.getByRole("textbox", { name: label, exact: true }).inputValue();
  expect(result).toContain("\n");
  expect(result).toContain("9007199254740993");
  expect(result).toContain("<img src=x onerror=alert(1)>");
  await expect(fixture.dialog.locator("img")).toHaveCount(0);
  await expect
    .poll(() => fixture.workers.some((url) => /\/app\/assets\/json\.worker-/u.test(url)))
    .toBe(true);
  expect(fixture.workers.every((url) => new URL(url).origin === new URL(page.url()).origin)).toBe(true);
  expect(fixture.external.filter((origin) => origin !== "null")).toEqual([]);
  fixture.check();
});

test("편집기 로딩 실패에도 기본 입력과 검토 초안을 유지한다", async ({ page }) => {
  const fixture = await setup(page),
    text = "자산 실패에도 남을 한글 초안";
  await fixture.dialog.getByRole("textbox", { name: "기준 프롬프트", exact: true }).fill(text);
  await page.route(/\/app\/assets\/MonacoEditor-[^/]+\.js$/u, (route) => route.abort("failed"));
  await fixture.dialog.getByRole("button", { name: "기준 프롬프트 코드 편집기 열기", exact: true }).click();
  await expect(
    fixture.dialog.getByText("코드 편집기를 사용할 수 없어 기본 입력을 표시합니다. 입력 내용은 유지됩니다."),
  ).toBeVisible();
  await expect(fixture.dialog.getByRole("textbox", { name: "기준 프롬프트", exact: true })).toHaveValue(text);
  await fixture.dialog.getByRole("button", { name: "변경 내용 검토" }).click();
  await expect(fixture.dialog.getByRole("heading", { name: "저장 전 변경 비교" })).toBeFocused();
  expect(fixture.writes).toEqual([]);
  fixture.check();
});

test("지연 로딩 중 한글 조합을 마친 뒤 전환하고 조합 중인 값을 잃지 않는다", async ({ page }) => {
  const fixture = await setup(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route(/\/app\/assets\/MonacoEditor-[^/]+\.js$/u, async (route) => {
    requested = true;
    await held;
    await route.continue();
  });
  try {
    await fixture.dialog.getByRole("button", { name: "기준 프롬프트 코드 편집기 열기", exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    const input = fixture.dialog.getByRole("textbox", { name: "기준 프롬프트", exact: true });
    await input.dispatchEvent("compositionstart");
    await input.fill("조합 중인 한글 초안");
    release();
    await expect(
      fixture.dialog.getByText("편집기를 준비하는 중입니다. 입력은 계속할 수 있습니다."),
    ).toBeHidden();
    await expect(input).toHaveValue("조합 중인 한글 초안");
    await expect(fixture.dialog.locator(".monaco-editor")).toHaveCount(0);
    await input.dispatchEvent("compositionend", { data: "안" });
    await expect(fixture.dialog.locator(".monaco-editor")).toBeVisible();
    await fixture.dialog
      .getByRole("button", { name: "기준 프롬프트 기본 입력으로 전환", exact: true })
      .click();
    await expect(input).toHaveValue("조합 중인 한글 초안");
    fixture.check();
  } finally {
    release();
  }
});

test("닫은 편집기의 찾기 이력은 새 편집기에 남지 않는다", async ({ page }) => {
  const fixture = await setup(page);
  let editor = await activate(fixture.dialog, "기준 프롬프트");
  await editor.getByRole("button", { name: "내용 찾기", exact: true }).click();
  await editor.locator(".find-widget textarea").first().fill("이전 편집기의 검색어");
  // Monaco commits find history after its documented 500ms input debounce.
  await page.waitForTimeout(600);
  await basic(editor, "기준 프롬프트");
  editor = await activate(fixture.dialog, "기준 프롬프트");
  await editor.getByRole("button", { name: "내용 찾기", exact: true }).click();
  const search = editor.locator(".find-widget textarea").first();
  await search.fill("");
  await search.press("ArrowUp");
  await expect(search).toHaveValue("");
  fixture.check();
});

for (const withdraw of [false, true]) {
  sqlTest(
    `SQL 편집은 공백을 유지하고 ${withdraw ? "권한 회수 시 저장을 차단" : "저장 중 편집을 잠금"}`,
    async ({ page, emergency }) => {
      const writes: unknown[] = [];
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/admin/text2sql/golden", async (route) => {
        writes.push(route.request().postDataJSON());
        await held;
        await route.fulfill({ json: { status: "saved" } });
      });
      await page.goto("login?return_to=%2Fapp%2Ftext2sql%3Ftab%3Dgolden");
      await page.getByLabel("이메일", { exact: true }).fill(sqlAccount.email);
      await page.getByLabel("비밀번호", { exact: true }).fill("public-password");
      await page.getByRole("button", { name: "로그인", exact: true }).click();
      await page.getByRole("button", { name: "Golden Query 추가", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Golden Query 추가", exact: true });
      await dialog.getByRole("textbox", { name: "이름", exact: true }).fill("공개 SQL 검사");
      await dialog.getByRole("textbox", { name: "자연어 질문", exact: true }).fill("한글 항목 조회");
      const editor = await activate(dialog, "기대 SQL");
      const sql =
        "SELECT\n  '한글', 9007199254740993 AS id\nFROM public_items\nWHERE label = '공개 SQL 검사'";
      await replace(page, editor, sql);
      if (withdraw) {
        emergency.readonly(true);
        const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/admin/ui-bootstrap");
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await (await response).finished();
        await expect(dialog.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
        await expect(editor.locator("textarea.inputarea")).not.toBeEditable();
        expect(writes).toEqual([]);
        release();
        return;
      }
      try {
        await dialog.getByRole("button", { name: "저장", exact: true }).click();
        await expect.poll(() => writes.length).toBe(1);
        await expect(editor.locator("textarea.inputarea")).not.toBeEditable();
        await expect(editor.getByRole("button", { name: "입력 되돌리기", exact: true })).toBeDisabled();
        expect(writes).toEqual([expect.objectContaining({ expected_sql: sql })]);
        release();
        await expect(dialog).toBeHidden();
      } finally {
        release();
      }
      expect(emergency.writes).toEqual([]);
    },
  );
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1440]) {
    test(`편집기 ${theme} ${width}px 화면은 찾기·Esc·Tab·초점 복귀와 접근성을 유지한다`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const fixture = await setup(page);
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      const editor = await activate(fixture.dialog, "기준 프롬프트");
      await replace(page, editor, "첫 질문\n다음 질문");
      await editor.getByRole("button", { name: "내용 찾기", exact: true }).click();
      await expect(editor.locator(".find-widget")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(fixture.dialog).toBeVisible();
      await expect(editor.locator("textarea.inputarea")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(editor.locator("textarea.inputarea")).not.toBeFocused();
      await page.route("**/app/assets/axe-audit.js", (route) =>
        route.fulfill({
          contentType: "application/javascript",
          body: readFileSync(new URL("../../node_modules/axe-core/axe.min.js", import.meta.url)),
        }),
      );
      await page.addScriptTag({ url: "/app/assets/axe-audit.js" });
      const violations = await page.evaluate(async () => {
        await Promise.all(
          document
            .getAnimations()
            .filter((a) => a.effect?.getTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => undefined)),
        );
        const result = await (window as unknown as { axe: typeof axe }).axe.run(document);
        return result.violations.map((v) => ({ id: v.id, count: v.nodes.length }));
      });
      expect(violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await editor.scrollIntoViewIfNeeded();
      await expect(fixture.dialog).toHaveScreenshot(`code-editor-${theme}-${width}.png`, {
        animations: "disabled",
      });
      await basic(editor, "기준 프롬프트");
      await expect(fixture.dialog.getByRole("textbox", { name: "기준 프롬프트", exact: true })).toBeFocused();
      fixture.check();
    });
  }
}
