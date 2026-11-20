import { expect } from "@playwright/test";
import { admin, login, reader, test } from "./live-fixture";
import type { DwRetryReviewedRequest } from "../../src/shared/api/generated";

let jobId = "";
let submitted: DwRetryReviewedRequest | undefined;
test("DW-RETRY-LIVE-001 실제 검토·사유·응답 유실 복구·중복 접수 보호", async ({ page }) => {
  await login(page, admin, "/app/data/warehouse?tab=pipeline");
  const writes: number[] = [];
  await page.route("**/admin/dw/sink-retry?reviewed=1", async (route) => {
    submitted = route.request().postDataJSON() as DwRetryReviewedRequest;
    // Deliver to the real authenticated Go route, then lose only its response.
    const response = await route.fetch();
    writes.push(response.status());
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "실패분 재처리", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "실패분 재처리 검토" });
  const table = dialog.getByRole("table", { name: "재처리 대상과 예상 건수" });
  await expect(table).toBeVisible();
  await expect(table.getByRole("row").last().getByRole("cell").nth(2)).toHaveText("1");
  expect(writes.length).toBe(0);
  await dialog.getByRole("textbox", { name: "실행 사유" }).fill("browser-dw-reviewed-recovery");
  await dialog.getByRole("button", { name: "검토한 대상 재처리" }).click();
  await dialog.getByRole("button", { name: "접수 결과 확인" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: "재처리 완료", exact: true })).toBeVisible();
  expect(writes).toEqual([202]);
  jobId = new URL(page.url()).searchParams.get("retry_job") ?? "";
  expect(/^dwr_[a-f0-9]{64}$/u.test(jobId)).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "재처리 완료", exact: true })).toBeVisible();
  await page.unroute("**/admin/dw/sink-retry?reviewed=1");
  if (!submitted) throw new Error("Reviewed request was not observed");
  const duplicate = await page.evaluate(async (input) => {
    const token = sessionStorage.getItem("vibe.app.auth.access") ?? "";
    const response = await fetch("/admin/dw/sink-retry?reviewed=1", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const result = (await response.json()) as { id?: string; status?: string };
    return {
      status: response.status,
      same: result.id === `dwr_${input.revision}`,
      complete: result.status === "succeeded",
    };
  }, submitted);
  expect(duplicate).toEqual({ status: 200, same: true, complete: true });
});
test("DW-RETRY-LIVE-002 실제 읽기 전용 계정의 실행·다른 계정 작업 조회 거부", async ({ page }) => {
  expect(Boolean(jobId && submitted)).toBe(true);
  await login(page, reader, `/app/data/warehouse?tab=pipeline&retry_job=${jobId}`);
  await expect(page.getByRole("button", { name: "실패분 재처리", exact: true })).toBeDisabled();
  await expect(page.getByText("재처리 작업 조회 권한을 확인하세요.")).toBeVisible();
  const rejected = await page.evaluate(
    async ({ id, input }) => {
      const headers = {
        Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
        "Content-Type": "application/json",
      };
      const read = await fetch(`/admin/dw/sink-retry?job_id=${id}`, { headers });
      const write = await fetch("/admin/dw/sink-retry?reviewed=1", {
        method: "POST",
        headers,
        body: JSON.stringify(input),
      });
      return { read: read.status, write: write.status };
    },
    { id: jobId, input: submitted },
  );
  expect(rejected).toEqual({ read: 403, write: 401 });
});
