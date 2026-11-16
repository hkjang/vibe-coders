import { expect, test } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installOverviewTrend } from "../fixtures/overview-trend-browser";

test("1시간 추이를 직접 열고 새로고침·탭 이동 후 주소와 실제 집계 단위를 유지한다", async ({ page }) => {
  const fixture = await installOverviewTrend(page);
  await page.goto("overview?tab=usage&trend=1h");
  const table = page.getByRole("table", { name: "최근 1시간 구간별 요청·토큰·비용" });
  await expect(table).toBeVisible();
  await expect(
    page.getByRole("group", { name: "추이 기간" }).getByRole("button", { name: "최근 1시간" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(table).toBeVisible();
  await page.getByRole("tab", { name: "운영 상태", exact: true }).click();
  await page.getByRole("tab", { name: "사용 현황", exact: true }).click();
  await expect(table).toBeVisible();
  await expect(page).toHaveURL(/trend=1h/);
  expect(fixture.trend.reads.length).toBeGreaterThanOrEqual(3);
  expect(fixture.trend.reads.every((value) => value.window === "1h" && value.bucket === "hour")).toBe(true);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("키보드로 비용을 정렬하고 같은 순서와 원래 정밀도의 CSV를 내려받는다", async ({ page }) => {
  const fixture = await installOverviewTrend(page);
  await page.goto("overview?tab=usage&trend=1h");
  const order = page.getByRole("button", { name: "비용 내림차순 정렬", exact: true });
  await order.focus();
  await order.press("Enter");
  const rows = page.getByRole("table", { name: "최근 1시간 구간별 요청·토큰·비용" }).getByRole("row");
  await expect(rows.nth(1)).toContainText("2026-11-17 02시");
  await expect(rows.nth(2)).toContainText("₩0.0004");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "구간 CSV 내려받기" }).click();
  const result = await download;
  expect(result.suggestedFilename()).toBe("사용-추이-1h.csv");
  let csv = "";
  for await (const chunk of await result.createReadStream()) csv += String(chunk);
  expect(csv).toContain("2026-11-16T17:00:00.000Z,시간,10,7,0.0012");
  expect(csv.indexOf("17:00:00")).toBeLessThan(csv.indexOf("16:00:00"));
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("조회 거부 후 표와 CSV를 정리하고 명시 재시도로 복구한다", async ({ page }) => {
  const fixture = await installOverviewTrend(page);
  await page.goto("overview?tab=usage&trend=1h");
  const table = page.getByRole("table", { name: "최근 1시간 구간별 요청·토큰·비용" });
  await expect(table).toBeVisible();
  fixture.trend.status = 403;
  await page.getByRole("button", { name: "전체 새로고침", exact: true }).click();
  await expect(table).toHaveCount(0);
  await expect(page.getByRole("button", { name: "구간 CSV 내려받기" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "요일·시간대 활동" })).toBeVisible();
  fixture.trend.status = 200;
  await page.getByRole("button", { name: "사용 추이 다시 시도", exact: true }).click();
  await expect(table).toBeVisible();
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("일시 오류의 마지막 정상 구간과 실제 빈 구간을 구분한다", async ({ page }) => {
  const fixture = await installOverviewTrend(page);
  await page.goto("overview?tab=usage&trend=1h");
  const table = page.getByRole("table", { name: "최근 1시간 구간별 요청·토큰·비용" });
  await expect(table).toBeVisible();
  fixture.trend.status = 503;
  await page.getByRole("button", { name: "전체 새로고침", exact: true }).click();
  await expect(page.getByText("요청 ID: trend-fixture")).toBeVisible();
  await expect(table).toContainText("₩0.0004");
  fixture.trend.status = 200;
  fixture.trend.empty = true;
  await page.getByRole("button", { name: "사용 추이 다시 시도", exact: true }).click();
  await expect(page.getByText(/이 기간에 기록된 구간이 없습니다/)).toBeVisible();
  await expect(page.getByRole("button", { name: "구간 CSV 내려받기" })).toBeDisabled();
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`${theme} ${width}px 사용 추이의 한글·접근성·시각 기준`, async ({ page }) => {
      const fixture = await installOverviewTrend(page);
      await page.setViewportSize({ width, height: 1800 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto("overview?tab=usage&trend=1h");
      const region = page.getByRole("region", { name: "사용 추이", exact: true });
      await expect(region.getByRole("table")).toBeVisible();
      const chart = region.getByRole("region", { name: "최근 1시간 비용 그래프 영역" });
      await expect(chart).toHaveAttribute("tabindex", "0");
      if (width === 390) {
        expect(await chart.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
        await chart.focus();
        await chart.press("ArrowRight");
        await expect.poll(() => chart.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
        await chart.press("ArrowLeft");
        await expect.poll(() => chart.evaluate((element) => element.scrollLeft)).toBe(0);
        await chart.blur();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(
        await page.evaluate(
          async () =>
            (
              await (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe.run(
                document,
              )
            ).violations,
        ),
      ).toEqual([]);
      await expect(region).toHaveScreenshot(`overview-trend-${theme}-${width}.png`, {
        animations: "disabled",
      });
      expect(fixture.writes).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  }
