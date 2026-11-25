import { expect } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { test } from "../fixtures/dw-insights-browser";
import { expectCellBoundaries } from "../fixtures/table-cell-boundaries";

test("키보드 날짜 선택과 CSV·주소 복원은 같은 기간을 유지한다", async ({ page, gateway }) => {
  await page.goto("data/warehouse");
  const first = page.getByRole("button", { name: /2024-02-29 \(UTC\), 비용/u });
  await first.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/since_day=2024-03-01&until_day=2024-03-02/u);
  const next = page.getByRole("button", { name: /2024-03-01 \(UTC\), 비용/u });
  await expect(next).toBeFocused();
  await expect(next).toHaveAttribute("aria-pressed", "true");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 내보내기" }).click();
  await download;
  expect(
    gateway.reads
      .filter((url) => url.pathname.endsWith("export.csv"))
      .at(-1)
      ?.searchParams.get("since_day"),
  ).toBe("2024-03-01");
  expect(
    gateway.reads
      .filter((url) => url.pathname.endsWith("export.csv"))
      .at(-1)
      ?.searchParams.get("until_day"),
  ).toBe("2024-03-02");
  await page.reload();
  await expect(page.getByText("상세 집계 · 2024-03-01 (UTC)")).toBeVisible();
  await page.getByRole("combobox", { name: "분석 차원", exact: true }).selectOption("provider");
  await expect(page.getByRole("table", { name: "공급자별 사용량과 비용" })).toBeVisible();
  await expect(page).toHaveURL(/since_day=2024-03-01/u);
  await page.getByRole("button", { name: "전체 기간으로 돌아가기" }).click();
  await expect(page).not.toHaveURL(/since_day/u);
});

test("첫 주는 실제 조회 시작일까지 잘라 상세 집계한다", async ({ page, gateway }) => {
  await page.goto("data/warehouse?bucket=week");
  await page.getByRole("button", { name: /2024-02-29 ~ 2024-03-03 \(UTC\), 비용/u }).click();
  await expect(page).toHaveURL(/since_day=2024-02-29&until_day=2024-03-04/u);
  await expect
    .poll(() =>
      gateway.reads
        .filter((url) => url.pathname.endsWith("dimensions"))
        .at(-1)
        ?.searchParams.get("since_day"),
    )
    .toBe("2024-02-29");
  await page.getByRole("combobox", { name: "집계 단위", exact: true }).selectOption("day");
  await expect(page).not.toHaveURL(/since_day/u);
});

for (const query of [
  "since_day=not-a-date&until_day=2024-03-01",
  "since_day=2024-02-29",
  "since_day=2024-02-29&since_day=2024-02-28&until_day=2024-03-01",
]) {
  test(`잘못된 기간은 빈 거부 표시로 유지하고 전체 조회로 바꾸지 않는다: ${query}`, async ({
    page,
    gateway,
  }) => {
    await page.goto(`data/warehouse?${query}`);
    await expect(page.getByText("선택 기간이 올바르지 않습니다.")).toBeVisible();
    await expect(page.getByRole("button", { name: "CSV 내보내기" })).toBeDisabled();
    expect(gateway.reads.filter((url) => url.pathname.endsWith("dimensions"))).toEqual([]);
    await expect(page).not.toHaveURL(/not-a-date/u);
    await page.reload();
    await expect(page.getByText("선택 기간이 올바르지 않습니다.")).toBeVisible();
  });
}
for (const failure of ["unsupported", "mismatch"] as const) {
  test(`선택 범위를 확인할 수 없는 서버 응답은 표시·내보내기를 거부한다: ${failure}`, async ({
    page,
    gateway,
  }) => {
    gateway[failure]();
    await page.goto("data/warehouse?since_day=2024-02-29&until_day=2024-03-01");
    await expect(page.getByRole("button", { name: "CSV 내보내기" })).toBeDisabled();
    await expect(
      page.getByText(failure === "unsupported" ? "선택 기간을 확인할 수 없습니다." : "차원별 집계 조회 실패"),
    ).toBeVisible();
    await expect(
      page.getByRole("table", { name: "모델별 사용량과 비용" }).getByText("₩24", { exact: true }),
    ).toHaveCount(0);
  });
}
for (const width of [390, 1440])
  for (const theme of ["light", "dark"] as const) {
    test(`DW 추이와 긴 표 데이터의 접근성·시각 검증 ${width}px ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.clock.setFixedTime(new Date("2026-11-20T08:00:00Z"));
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto("data/warehouse?since_day=2024-02-29&until_day=2024-03-01");
      const table = page.getByRole("table", { name: "모델별 사용량과 비용" });
      await expect(table).toBeVisible();
      await expectCellBoundaries(table);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      expect(overflow).toBe(false);
      const chart = page
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: "비용 추이", exact: true }) });
      await expect(chart.getByRole("button", { name: /2024-02-29 \(UTC\), 비용/u })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      const violations = await page.evaluate(
        async () =>
          (
            await (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe.run(
              document,
            )
          ).violations,
      );
      expect(violations).toEqual([]);
      await chart.screenshot({ path: info.outputPath(`dw-trend-${theme}-${width}.png`) });
      await expect(chart).toHaveScreenshot(`dw-trend-${theme}-${width}.png`);
      await chart.getByText("추이 데이터 표로 보기", { exact: true }).click();
      await expect(page.getByRole("table", { name: "일자별 요청, 토큰, 비용, 오류" })).toBeVisible();
    });
  }
