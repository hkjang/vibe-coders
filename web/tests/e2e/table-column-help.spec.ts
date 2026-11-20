import { expect, test } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installRequestBulk } from "../fixtures/request-bulk-browser";

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`${width}px ${theme} 요청 열 설명`, () => {
      test.use({ viewport: { width, height: 900 }, colorScheme: theme, hasTouch: width === 390 });
      test("키보드·터치 설명과 최소 열 너비·CSV를 함께 유지한다", async ({ page }, info) => {
        const fixture = await installRequestBulk(page);
        const chunks: string[] = [];
        page.on("request", (request) => {
          if (/ColumnTooltip-[\w-]+\.js/u.test(request.url())) chunks.push(request.url());
        });
        await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
        await page.goto("observability/requests");
        const table = page.getByRole("table", { name: "현재 페이지 요청 목록" });
        await expect(table).toBeVisible();
        const help = page.getByRole("button", { name: "지연 열 설명", exact: true });
        expect(chunks).toEqual([]);
        await help.focus();
        const tip = page.locator(".data-table-column-help");
        await expect(tip).toContainText("1,000밀리초(ms)는 1초");
        expect(chunks).toHaveLength(1);
        await expect(help).toBeFocused();
        await expect(help).toHaveAttribute("aria-describedby", (await tip.getAttribute("id")) ?? "");
        await expect(tip).toBeInViewport();
        await page.keyboard.press("Escape");
        await expect(tip).toHaveCount(0);
        await expect(help).toBeFocused();
        if (width === 390) await help.tap();
        else await help.click();
        await expect(tip).toBeVisible();
        await expect(tip).toBeInViewport();
        await page.keyboard.press("Escape");

        const resize = page.getByRole("separator", { name: "지연 열 너비 조절", exact: true });
        await resize.focus();
        await page.keyboard.press("Home");
        await expect(resize).toHaveAttribute("aria-valuenow", "80");
        await help.focus();
        await expect(tip).toBeVisible();
        const control = await help.boundingBox();
        const handle = await resize.boundingBox();
        if (!control || !handle) throw new Error("열 설명 또는 너비 조절을 찾을 수 없습니다.");
        expect(control.width).toBeGreaterThanOrEqual(24);
        expect(control.height).toBeGreaterThanOrEqual(24);
        expect(control.x + control.width).toBeLessThanOrEqual(handle.x + 1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(
          await page.evaluate(
            async () =>
              (
                await (
                  window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }
                ).axe.run(document)
              ).violations,
          ),
        ).toEqual([]);
        await page.screenshot({ path: info.outputPath("column-help.png") });
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "비용 열 설명", exact: true }).focus();
        await expect(tip).toContainText("통화 간 환산이나 합산을 하지 않으며");
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "여러 요청 선택", exact: true }).click();
        await page.getByRole("checkbox", { name: "1번째 요청 선택", exact: true }).check();
        const download = page.waitForEvent("download");
        await page.getByRole("button", { name: "선택한 요청 CSV", exact: true }).click();
        let csv = "";
        for await (const chunk of await (await download).createReadStream()) csv += String(chunk);
        expect(csv).toContain(String(fixture.rows[0]?.estimated_cost));
        expect(csv).toContain("요청-1");
        expect(fixture.bulk.reads).toBe(1);
        expect(fixture.writes).toEqual([]);
        expect(fixture.unexpected).toEqual([]);
      });
    });
  }
}

test("마우스가 설명으로 이동해도 유지하고 바깥으로 나가면 닫는다", async ({ page }) => {
  const fixture = await installRequestBulk(page);
  await page.goto("observability/requests");
  await page.getByRole("button", { name: "토큰 열 설명", exact: true }).hover();
  const tip = page.locator(".data-table-column-help");
  await expect(tip).toContainText("캐시·추론 토큰을 여기에 다시 더하지 않으며");
  await tip.hover();
  await expect(tip).toBeVisible();
  await page.getByRole("heading", { name: "요청 탐색기", exact: true }).hover();
  await expect(tip).toHaveCount(0);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("설명 파일을 기다리다 닫으면 늦게 도착해도 다시 열리지 않는다", async ({ page }) => {
  const fixture = await installRequestBulk(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route(/ColumnTooltip-[\w-]+\.js/u, async (route) => {
    requested = true;
    await held;
    await route.continue();
  });
  await page.goto("observability/requests");
  const help = page.getByRole("button", { name: "지연 열 설명", exact: true });
  await help.focus();
  await expect.poll(() => requested).toBe(true);
  await page.keyboard.press("Escape");
  await expect(help).toBeFocused();
  const response = page.waitForResponse(/ColumnTooltip-[\w-]+\.js/u);
  release();
  await response;
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page.locator(".data-table-column-help")).toBeVisible();
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
