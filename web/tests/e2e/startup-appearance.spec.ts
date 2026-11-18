import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const manifest = JSON.parse(readFileSync("dist/.vite/manifest.json", "utf8")) as Record<
  string,
  { file: string }
>;
const runtime = `/app/${manifest["src/main.tsx"]?.file ?? "missing-runtime"}`;

for (const preference of ["light", "dark", "system", "malformed", "version", "denied"] as const) {
  test(`React 실패 안내도 첫 콘텐츠부터 저장된 표시를 사용한다: ${preference}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: preference === "dark" ? "light" : "dark" });
    await page.addInitScript((value) => {
      const key = "vibe.app.preferences.v1";
      const saved =
        value === "malformed"
          ? "{"
          : JSON.stringify({
              state: { theme: value === "version" ? "light" : value, density: "compact" },
              version: value === "version" ? 999 : 0,
            });
      localStorage.setItem(key, saved);
      if (value === "denied")
        Object.defineProperty(window, "localStorage", {
          get() {
            throw new DOMException("Storage disabled", "SecurityError");
          },
        });
      const observer = new MutationObserver(() => {
        if (!document.getElementById("root")?.firstElementChild) return;
        document.documentElement.dataset.firstContentTheme =
          document.documentElement.dataset.theme ?? "missing";
        observer.disconnect();
      });
      observer.observe(document, { childList: true, subtree: true });
    }, preference);
    await page.route(`**${runtime}`, (route) => route.abort("failed"));
    await page.goto("gateway/health");
    await expect(page.getByRole("heading", { name: "신규 콘솔을 불러오지 못했습니다." })).toBeVisible();
    const theme = preference === "light" ? "light" : "dark";
    await expect(page.locator("html")).toHaveAttribute("data-first-content-theme", theme);
    await expect(page.locator("html")).toHaveCSS("color-scheme", theme);
    await expect(page.locator("html")).toHaveAttribute(
      "data-density",
      ["light", "dark", "system"].includes(preference) ? "compact" : "default",
    );
    const early = page.locator('head script[src*="/appearance-"]');
    await expect(early).toHaveCount(1);
    expect(
      await early.evaluate(
        (element) =>
          element.hasAttribute("async") ||
          element.hasAttribute("defer") ||
          element.getAttribute("type") === "module",
      ),
    ).toBe(false);
  });
}

test("표시 설정 파일을 받지 못해도 시작 복구 안내를 유지한다", async ({ page }) => {
  await page.route("**/app/assets/appearance-*.js", (route) => route.abort("failed"));
  await page.route(`**${runtime}`, (route) => route.abort("failed"));
  await page.goto("gateway/health");
  await expect(page.getByRole("heading", { name: "신규 콘솔을 불러오지 못했습니다." })).toBeVisible();
  await expect(page.getByRole("button", { name: "현재 주소로 다시 시도" })).toBeEnabled();
  await expect(page.getByRole("link", { name: "콘솔 처음 화면 열기" })).toHaveAttribute("href", "/app/");
});
