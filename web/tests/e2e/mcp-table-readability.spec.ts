import { expect } from "@playwright/test";
import { first, second, test } from "../fixtures/mcp-upstream-gateway";
import { expectCellBoundaries } from "../fixtures/table-cell-boundaries";
import { expectReadableTableText } from "../fixtures/table-text-readability";

for (const width of [1440, 390]) {
  test(`MCP 이름 열은 ${width}px에서 주소 옆에서도 읽을 폭을 유지한다`, async ({ page, gateway }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("mcp?tab=upstreams");
    const name = page.getByText(first.name, { exact: true });
    await expect(name).toBeVisible();
    const table = name.locator("xpath=ancestor::table");
    const cell = name.locator("xpath=ancestor::td");
    const bounds = await cell.evaluate((element) => ({
      width: element.clientWidth,
      height: element.clientHeight,
    }));
    expect(bounds.width).toBeGreaterThanOrEqual(128);
    expect(bounds.height).toBeLessThanOrEqual(90);
    await expectCellBoundaries(table);
    await expectReadableTableText(table);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("mcp-name-columns.png"), fullPage: true });
    expect(gateway.writes).toEqual([]);
  });

  test(`MCP의 긴 이름과 주소는 ${width}px에서 옆 열을 침범하지 않는다`, async ({ page, gateway }) => {
    const name = "긴한글서버이름".repeat(16);
    await page.route("**/admin/mcp/upstreams", (route) =>
      route.fulfill({
        json: {
          upstreams: [
            { ...first, name, url: `https://example.invalid/${"long-endpoint/".repeat(30)}` },
            second,
          ],
          discovery_errors: {},
        },
      }),
    );
    await page.setViewportSize({ width, height: 900 });
    await page.goto("mcp?tab=upstreams");
    const title = page.getByText(name, { exact: true });
    await expect(title).toBeVisible();
    await expectCellBoundaries(title.locator("xpath=ancestor::table"));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(gateway.writes).toEqual([]);
  });
}
