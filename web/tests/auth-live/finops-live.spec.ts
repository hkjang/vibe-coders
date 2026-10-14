import { expect } from "@playwright/test";
import { admin, login, test } from "./live-fixture";

test("AUTH-LIVE-031 실제 정산 오류 건수와 안전한 CSV 내보내기", async ({ page }) => {
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
});
