import { expect } from "@playwright/test";
import { admin, login, reader, test } from "./live-fixture";

const path = "/app/routing/rules";

test("AUTH-LIVE-037 실제 규칙 비교·순서 저장·새로고침과 감사 기록", async ({ page }) => {
  await login(page, admin, path);
  await page.getByRole("button", { name: "규칙 순서 변경", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "규칙 순서 변경", exact: true });
  await dialog.getByRole("button", { name: "2번째 규칙 위로" }).click();
  await dialog
    .getByRole("textbox", { name: "변경 사유", exact: true })
    .fill("browser-routing-order-reviewed");
  await dialog.getByRole("textbox", { name: "검증할 모델명", exact: true }).fill("browser-order-request");
  await dialog.getByRole("button", { name: "순서 변경 비교" }).click();
  await expect(dialog.getByRole("region", { name: "변경 전 선택" })).toContainText("browser-order-a");
  await expect(dialog.getByRole("region", { name: "변경 후 선택" })).toContainText("browser-order-b");
  const save = dialog.getByRole("button", { name: "검토한 순서 저장" });
  await expect(save).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  const received = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" && new URL(response.url()).pathname === "/admin/routing-rules",
  );
  await save.click();
  expect((await received).status()).toBe(200);
  await expect(dialog).toContainText("라우팅 규칙 순서와 감사 기록을 저장했습니다.");
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("table").getByRole("row").nth(1)).toContainText("browser-order-b");
  // The Go harness independently checks all stored fields and the single audit.
});

test("AUTH-LIVE-038 라우팅 권한 없는 조회 계정의 화면과 실제 API 접근을 거부한다", async ({ page }) => {
  await login(page, reader, path);
  await expect(page.getByRole("alert")).toContainText("접근 권한이 없습니다.");
  await expect(page.getByRole("button", { name: "규칙 순서 변경", exact: true })).toHaveCount(0);
  const statuses = await page.evaluate(async () => {
    const headers = {
      Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
      "Content-Type": "application/json",
    };
    const before = await fetch("/admin/routing-rules?view=order", { headers });
    const denied = await fetch("/admin/routing-rules", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        order: ["browser-order-a", "browser-order-b"],
        expected_revision: "0".repeat(64),
        reason: "must-be-denied",
      }),
    });
    return [before.status, denied.status];
  });
  expect(statuses).toEqual([401, 401]);
});
