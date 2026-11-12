import { readFileSync } from "node:fs";
import { expect, type Locator, type Page } from "@playwright/test";

/** Synthetic business APIs, production assets, and the actual Go console CSP. */
export async function watchEditorAssets(page: Page) {
  const headers = readFileSync(new URL("../../../internal/appui/headers.go", import.meta.url), "utf8");
  const literal = headers.match(/const appContentSecurityPolicy = ("[^\n]+")/u)?.[1];
  if (!literal) throw new Error("Go application CSP is missing");
  const csp = JSON.parse(literal) as string;
  const assets: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/app/assets/")) assets.push(request.url());
  });
  await page.route("**/app/**", async (route) => {
    if (!route.request().isNavigationRequest()) return route.fallback();
    const response = await route.fetch();
    return route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": csp } });
  });
  return {
    expectDeferred() {
      expect(assets.some((url) => /MonacoEditor|jsonMode|\.worker-/u.test(url))).toBe(false);
    },
  };
}

export async function activateEditor(dialog: Locator, label: string) {
  await dialog.getByRole("button", { name: `${label} 코드 편집기 열기`, exact: true }).click();
  const editor = dialog.locator(".code-editor").filter({
    has: dialog.page().getByRole("button", { name: `${label} 기본 입력으로 전환`, exact: true }),
  });
  await expect(editor.locator("textarea.inputarea")).toBeFocused();
  return editor;
}

export async function replaceCode(editor: Locator, value: string) {
  await editor.locator("textarea.inputarea").focus();
  await editor.page().keyboard.press("ControlOrMeta+A");
  if (value === "") await editor.page().keyboard.press("Backspace");
  else await editor.page().keyboard.insertText(value);
}

export async function refreshRuntime(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
