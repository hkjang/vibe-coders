import { readFileSync } from "node:fs";
import { expect } from "@playwright/test";
import { test, targetUrl } from "../fixtures/request-flow-safety-gateway";

const manifest = JSON.parse(readFileSync("dist/.vite/manifest.json", "utf8")) as Record<
  string,
  { file: string }
>;
const entry = `/app/${manifest["index.html"]?.file ?? "missing-entry"}`;
const runtime = `/app/${manifest["src/main.tsx"]?.file ?? "missing-runtime"}`;
const loginPath = `/app/login?return_to=${encodeURIComponent(targetUrl)}`;
// Activate the anonymous-session fixture for every page. The embedded smoke
// server itself runs in open mode and is not the login contract under test.
test.beforeEach(async ({ gateway }) => {
  expect(gateway.unexpected).toEqual([]);
});
const failureTitle = "신규 콘솔을 불러오지 못했습니다.";

for (const failure of ["network", "evaluation", "shared"] as const) {
  test(`${failure}: 본체 진입 실패를 알리고 사용자 재시도로 원래 로그인 주소를 복구한다`, async ({
    page,
  }) => {
    let attempts = 0;
    let unhandled = 0;
    page.on("pageerror", () => unhandled++);
    const blocked =
      failure === "shared"
        ? `/app/${Object.values(manifest).find((entry) => entry.file.includes("settings-recovery-shared-"))?.file ?? "missing-shared"}`
        : runtime;
    await page.route(`**${blocked}`, (route) => {
      attempts++;
      if (attempts > 1) return route.continue();
      return failure !== "evaluation"
        ? route.abort("failed")
        : route.fulfill({
            status: 200,
            contentType: "application/javascript",
            body: 'throw new Error("SYNTHETIC_PRIVATE_ENTRY_FAILURE");',
          });
    });
    await page.goto(loginPath);
    await expect(page.getByRole("heading", { name: failureTitle })).toBeFocused();
    await expect(page.getByRole("alert")).toContainText("현재 주소로 다시 시도");
    expect(await page.locator("body").innerText()).not.toContain("SYNTHETIC_PRIVATE_ENTRY_FAILURE");
    expect(unhandled).toBe(0);
    expect(attempts).toBe(1);
    await expect(page.locator('a[href="/admin"]')).toHaveCount(0);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "현재 주소로 다시 시도" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("return_to")).toBe(targetUrl);
    expect(attempts).toBe(2);
    await expect(page.locator("#app-startup")).toHaveCount(0);
  });
}

test("작은 시작 파일까지 실패해도 기본 안내와 고정된 처음 화면 링크를 유지한다", async ({ page }) => {
  await page.route(`**${entry}`, (route) => route.abort("failed"));
  await page.goto(loginPath);
  await expect(page.getByRole("heading", { name: "신규 콘솔을 준비하고 있습니다." })).toBeVisible();
  const link = page.getByRole("link", { name: "콘솔 처음 화면 열기" });
  await expect(link).toHaveAttribute("href", "/app/");
  await expect(page.getByRole("button", { name: "현재 주소로 다시 시도" })).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
  await page.unroute(`**${entry}`);
  const navigation = page.waitForRequest(
    (request) => request.isNavigationRequest() && new URL(request.url()).pathname === "/app/",
  );
  await page.keyboard.press("Enter");
  expect(new URL((await navigation).url()).search).toBe("");
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
});

test("JavaScript를 꺼도 안내와 키보드 처음 화면 이동이 동작한다", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  try {
    const page = await context.newPage();
    await page.goto("providers?page=2");
    // Playwright's text/ARIA engines intentionally skip NOSCRIPT itself.
    // Target its rendered child to assert actual text and visibility with JS off.
    const message = page.locator("noscript p");
    await expect(message).toHaveText(
      "이 콘솔은 JavaScript가 필요합니다. 브라우저 설정을 확인한 뒤 다시 열어 주세요.",
    );
    await expect(message).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "콘솔 처음 화면 열기" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new URL("/app/", page.url()).href);
    expect(new URL(page.url()).search).toBe("");
    await expect(page.locator('a[href="/admin"]')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("스타일 파일 실패도 복구 화면을 지우지 않는다", async ({ page }) => {
  await page.route("**/app/assets/*.css", (route) => route.abort("failed"));
  await page.goto(loginPath);
  await expect(page.getByRole("heading", { name: failureTitle })).toBeVisible();
  await expect(page.getByRole("button", { name: "현재 주소로 다시 시도" })).toBeEnabled();
  await expect(page.getByRole("link", { name: "콘솔 처음 화면 열기" })).toBeVisible();
});

test("정상 직접 주소에서는 기본 안내가 React 로그인 화면으로 대체된다", async ({ page }) => {
  await page.goto(loginPath);
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
  await expect(page.locator("#app-startup")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("return_to")).toBe(targetUrl);
  await page.reload();
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`${theme} ${width}px 시작 복구의 한글 안내·대비·키보드·화면 기준`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.route(`**${runtime}`, (route) => route.abort("failed"));
      await page.goto(loginPath);
      await expect(page.getByRole("heading", { name: failureTitle })).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page).toHaveScreenshot(`startup-recovery-${theme}-${width}.png`, {
        animations: "disabled",
      });
      const violations = await page.evaluate(async () => {
        const axe = (
          window as unknown as { axe: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
        ).axe;
        return (await axe.run(document)).violations.map((item) => item.id);
      });
      expect(violations).toEqual([]);
    });
  }
}
