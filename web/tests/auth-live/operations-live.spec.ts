import { expect, type Page } from "@playwright/test";
import { admin, login, reader, test } from "./live-fixture";

const path = "/app/system/settings?tab=operations";

async function confirmOperation(page: Page, kind: "retention" | "replay") {
  const retention = kind === "retention";
  await page.getByRole("button", { name: retention ? "지금 정리 실행" : "DB로 재처리", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: retention ? "지금 정리 실행" : "저장 실패 로그 재처리",
    exact: true,
  });
  const confirm = dialog.getByRole("button", { name: retention ? "정리 실행" : "재처리 실행", exact: true });
  await expect(confirm).toBeDisabled();
  await dialog
    .getByRole("textbox", { name: "변경 사유", exact: true })
    .fill(retention ? "browser-retention-reviewed" : "browser-replay-reviewed");
  await expect(confirm).toBeDisabled();
  await dialog
    .getByRole("textbox", { name: "확인 문구", exact: true })
    .fill(retention ? "데이터 정리" : "로그 재처리");
  await expect(confirm).toBeEnabled();
  return { dialog, confirm };
}

test("AUTH-LIVE-016 실제 정리 확인·사유 전달·저장 데이터 삭제", async ({ page }) => {
  await login(page, admin, path);
  const { dialog, confirm } = await confirmOperation(page, "retention");
  const received = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/admin/retention",
  );
  await confirm.click();
  const response = await received;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toEqual({ reason: "browser-retention-reviewed" });
  await expect(dialog).toBeHidden();
  // The Go harness independently verifies the expired row and durable audit pair.
});

test("AUTH-LIVE-017 실제 재처리 완료 뒤 응답 유실은 중복 실행하지 않는다", async ({ page }) => {
  await login(page, admin, path);
  let writes = 0;
  let committed = false;
  await page.route("**/admin/fallback", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    writes += 1;
    expect(route.request().postDataJSON()).toEqual({ reason: "browser-replay-reviewed" });
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    const result: { imported?: number; failed?: number } = await response.json();
    committed = result.imported === 1 && result.failed === 0;
    // Drop a genuinely committed Go response, not a fabricated server result.
    await route.abort("failed");
  });
  const { dialog, confirm } = await confirmOperation(page, "replay");
  await confirm.click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(confirm).toBeDisabled();
  await page.keyboard.press("Enter");
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByRole("button", { name: "DB로 재처리", exact: true })).toBeDisabled();
  expect({ writes, committed }).toEqual({ writes: 1, committed: true });
});

test("AUTH-LIVE-018 조회 계정의 운영 실행은 UI와 실제 서버에서 거부한다", async ({ page }) => {
  await login(page, reader, path);
  for (const name of ["지금 정리 실행", "DB로 재처리", "테스트 메시지 발송", "알림 설정 저장"])
    await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
  const statuses = await page.evaluate(async () => {
    const headers = {
      Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
      "Content-Type": "application/json",
    };
    const results: number[] = [];
    for (const endpoint of ["/admin/retention", "/admin/fallback"]) {
      results.push((await fetch(endpoint, { headers })).status);
      results.push(
        (
          await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({ reason: "must-be-denied" }),
          })
        ).status,
      );
    }
    return results;
  });
  expect(statuses).toEqual([200, 401, 200, 401]);
});
