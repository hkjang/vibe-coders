import { expect } from "@playwright/test";
import { admin, login, reader, test } from "./live-fixture";

interface Series {
  bucket: string;
  since: string;
  points: { date: string; bucket: string; requests: number; tokens: number; cost_krw: number }[];
}

for (const [id, role, account] of [
  ["AUTH-LIVE-047", "관리자", admin],
  ["AUTH-LIVE-048", "읽기 전용 관리자", reader],
] as const) {
  test(`${id} 실제 ${role}의 1시간 집계·구간 표·CSV 정합성`, async ({ page }) => {
    const response = page.waitForResponse((value) => {
      const url = new URL(value.url());
      return (
        url.pathname === "/admin/timeseries" &&
        url.searchParams.get("window") === "1h" &&
        value.status() === 200
      );
    });
    await login(page, account, "/app/overview?tab=usage&trend=1h");
    const data: Series = await (await response).json();
    expect(data.bucket).toBe("hour");
    expect(data.points.length > 0 && data.points.every((point) => point.bucket === "hour")).toBe(true);
    const table = page.getByRole("table", { name: "최근 1시간 구간별 요청·토큰·비용" });
    await expect(table).toBeVisible();
    await expect(table.getByRole("row")).toHaveCount(data.points.length + 1);
    await page.getByRole("button", { name: "비용 내림차순 정렬", exact: true }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "구간 CSV 내려받기", exact: true }).click();
    let csv = "";
    for await (const chunk of await (await download).createReadStream()) csv += String(chunk);
    const actual = csv
      .replace(/^\uFEFF/u, "")
      .trimEnd()
      .split("\r\n")
      .slice(1);
    const expected = [...data.points]
      .sort((a, b) => b.cost_krw - a.cost_krw)
      .map(
        (point) =>
          `${new Date(`${point.date}:00:00+09:00`).toISOString()},시간,${point.requests},${point.tokens},${point.cost_krw}`,
      );
    // Boolean assertion keeps even synthetic aggregate response text out of failure diagnostics.
    expect(JSON.stringify(actual) === JSON.stringify(expected)).toBe(true);
    await page.reload();
    await expect(table).toBeVisible();
    expect(new URL(page.url()).searchParams.get("trend")).toBe("1h");
  });
}
