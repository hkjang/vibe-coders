import { expect, test } from "@playwright/test";
import { installGatewayHealthWorkspace } from "../fixtures/gateway-health-workspace-browser";

for (const preference of ["system", "dark"] as const)
  test(`${preference} 테마를 첫 콘텐츠 전에 적용하고 표시 설정·새로고침을 유지한다`, async ({ page }) => {
    await installGatewayHealthWorkspace(page);
    await page.emulateMedia({ colorScheme: preference === "system" ? "dark" : "light" });
    await page.addInitScript((theme) => {
      if (!localStorage.getItem("vibe.app.preferences.v1"))
        localStorage.setItem(
          "vibe.app.preferences.v1",
          JSON.stringify({ state: { theme, density: "compact" }, version: 0 }),
        );
      const observer = new MutationObserver(() => {
        if (!document.getElementById("root")?.firstElementChild) return;
        document.documentElement.dataset.firstContentTheme =
          document.documentElement.dataset.theme ?? "missing";
        observer.disconnect();
      });
      observer.observe(document, { childList: true, subtree: true });
    }, preference);
    await page.goto("gateway/health");
    await expect(page.getByText("세션 해시 분배", { exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-first-content-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
    const values = page.locator(".metric-pairs dd");
    expect(await values.count()).toBeGreaterThan(0);
    for (const value of await values.all()) await expect(value).toHaveCSS("color", "rgb(231, 234, 240)");

    await page.getByLabel("화면 표시 설정", { exact: true }).click();
    await page.getByRole("combobox", { name: "테마", exact: true }).selectOption("light");
    await page.getByRole("combobox", { name: "정보 밀도", exact: true }).selectOption("comfortable");
    for (const value of await values.all()) await expect(value).toHaveCSS("color", "rgb(23, 32, 51)");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.reload();
    await expect(page.getByText("세션 해시 분배", { exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-first-content-theme", "light");
    await expect(page.locator("html")).toHaveAttribute("data-density", "comfortable");
    await page.getByLabel("화면 표시 설정", { exact: true }).click();
    await page.getByRole("combobox", { name: "테마", exact: true }).selectOption("system");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
