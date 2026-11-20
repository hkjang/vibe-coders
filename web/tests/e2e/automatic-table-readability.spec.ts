import { expect, test } from "@playwright/test";
import { installText2SqlWorkspace } from "../fixtures/text2sql-workspace-browser";
import { expectCellBoundaries } from "../fixtures/table-cell-boundaries";

for (const width of [1440, 390]) {
  test(`자동 너비 표는 ${width}px에서 시각과 모델을 세로 한 글자씩 압축하지 않는다`, async ({
    page,
  }, info) => {
    const fixture = await installText2SqlWorkspace(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("text2sql");
    const table = page.getByRole("table", { name: "최근 Text2SQL 질의", exact: true });
    await expect(table.getByText("지난달 주문 건수", { exact: true })).toBeVisible();
    const sizes = await table
      .locator("tbody tr")
      .first()
      .locator("td")
      .evaluateAll((cells) => cells.map((cell) => ({ width: cell.clientWidth, height: cell.clientHeight })));
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) {
      expect(size.width).toBeGreaterThanOrEqual(128);
      expect(size.height).toBeLessThanOrEqual(130);
    }
    await expectCellBoundaries(table);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await table
      .locator("xpath=ancestor::section[1]")
      .screenshot({ path: info.outputPath("automatic-table.png") });
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}
