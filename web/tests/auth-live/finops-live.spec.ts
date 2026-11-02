import { expect } from "@playwright/test";
import { admin, login, test } from "./live-fixture";

test("AUTH-LIVE-031 실제 정산 오류 건수·CSV와 전체 비용 집계", async ({ page }) => {
  await login(page, admin, "/app/finops?tab=chargeback&month=2026-10");
  const row = page
    .getByRole("table", { name: "프로젝트 비용 배부", exact: true })
    .getByRole("row")
    .filter({ hasText: "=1+1" });
  await expect(row.getByRole("cell").last()).toHaveText("1");
  const result = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 다운로드", exact: true }).click();
  const download = await result;
  expect(download.suggestedFilename()).toBe("chargeback-2026-10.csv");
  const stream = await download.createReadStream();
  if (!stream) throw new Error("CSV stream unavailable");
  let text = "";
  for await (const chunk of stream) text += String(chunk);
  // Assert booleans only: neither body nor private download path enters reports.
  expect(text.includes("2026-10,project,'=1+1,1,7,12.3,1")).toBe(true);
  expect(text.includes("2026-10,project,=1+1,")).toBe(false);
  const dashboardResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/billing/dashboard" && response.request().method() === "GET",
  );
  await page.goto("/app/finops?window=30d");
  const response = await dashboardResponse;
  expect(response.status()).toBe(200);
  const dashboard = (await response.json()) as {
    totals_scope?: string;
    unavailable_sections?: string[];
    total_cost_krw?: number;
  };
  expect(dashboard.totals_scope === "all_retained_requests").toBe(true);
  expect(Array.isArray(dashboard.unavailable_sections) && dashboard.unavailable_sections.length === 0).toBe(
    true,
  );
  // The fixed CSV month may fall outside this rolling window in future runs.
  expect(typeof dashboard.total_cost_krw === "number" && Number.isFinite(dashboard.total_cost_krw)).toBe(
    true,
  );
  await expect(page.getByText("총 비용", { exact: true })).toBeVisible();
  await expect(page.getByText(/보관 중인 전체 요청 기준/)).toBeVisible();
});
