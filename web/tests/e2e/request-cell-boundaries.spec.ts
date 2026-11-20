import { expect, test } from "@playwright/test";
import { installRequestBulk } from "../fixtures/request-bulk-browser";
import { expectCellBoundaries } from "../fixtures/table-cell-boundaries";

for (const width of [1440, 390]) {
  test(`요청 표의 긴 식별자·모델은 ${width}px에서 여백을 보존하고 CSV 원문을 유지한다`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await installRequestBulk(page);
    const row = fixture.rows[0];
    if (!row) throw new Error("Fixture row is required");
    row.request_id = "공개요청식별자_".repeat(12);
    row.model = "public-model-".repeat(16);
    await page.goto("observability/requests");
    const table = page.getByRole("table", { name: "현재 페이지 요청 목록" });
    await expect(table.getByRole("cell", { name: row.model, exact: true })).toBeVisible();
    await expectCellBoundaries(table);
    for (const name of ["요청 ID", "모델"]) {
      await page.getByRole("separator", { name: `${name} 열 너비 조절`, exact: true }).press("Home");
      await expectCellBoundaries(table);
    }
    await page.getByRole("button", { name: "여러 요청 선택", exact: true }).click();
    await page.getByRole("checkbox", { name: "1번째 요청 선택", exact: true }).check();
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "선택한 요청 CSV", exact: true }).click();
    let csv = "";
    for await (const chunk of await (await downloading).createReadStream()) csv += String(chunk);
    expect(csv).toContain(row.request_id);
    expect(csv).toContain(row.model);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}
