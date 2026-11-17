import { expect, type Page } from "@playwright/test";
import { admin, login, reader, test } from "./live-fixture";

async function prepare(page: Page, target: string) {
  await login(page, admin, "/app/routing/rules");
  await page
    .getByRole("button", { name: `browser-order-request → ${target} 규칙 수정`, exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "라우팅 규칙 수정", exact: true });
  await dialog.getByRole("textbox", { name: "대상 모델", exact: true }).fill("browser-draft-candidate");
  await dialog.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
  await dialog.getByRole("textbox", { name: "시험 모델", exact: true }).fill("browser-order-request");
  await dialog.getByRole("textbox", { name: "예시 요청", exact: true }).fill("공개 시험 요청");
  await dialog.getByRole("textbox", { name: "변경 사유", exact: true }).fill("browser-draft-reviewed");
  const response = page.waitForResponse(
    (item) => item.request().method() === "POST" && new URL(item.url()).pathname === "/admin/routing/preview",
  );
  await dialog.getByRole("button", { name: "초안 결과 비교", exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(dialog.getByRole("heading", { name: "실행 계획 비교 결과" })).toBeVisible();
  return dialog;
}
test("ROUTING-DRAFT-LIVE-001 실제 초안 비교와 감사 포함 저장", async ({ page }) => {
  const dialog = await prepare(page, "browser-order-a");
  await expect(dialog).toContainText("browser-draft-candidate (변경)");
  const response = page.waitForResponse(
    (item) =>
      item.request().method() === "PATCH" &&
      new URL(item.url()).pathname === "/admin/routing-rules/browser-order-a",
  );
  await dialog.getByRole("button", { name: "규칙 저장", exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(dialog).toContainText("라우팅 규칙을 저장했습니다.");
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("table", { name: "복잡도 기반 라우팅 규칙 목록" })).toContainText(
    "browser-draft-candidate",
  );
});
test("ROUTING-DRAFT-LIVE-002 다른 규칙 변경 후 이전 검토 저장 거부", async ({ page }) => {
  const dialog = await prepare(page, "browser-order-b");
  const changed = await page.evaluate(async () => {
    const response = await fetch("/admin/routing-rules/browser-order-a", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ note: "draft-conflict-fixture" }),
    });
    return response.status;
  });
  expect(changed).toBe(200);
  const response = page.waitForResponse(
    (item) =>
      item.request().method() === "PATCH" &&
      new URL(item.url()).pathname === "/admin/routing-rules/browser-order-b",
  );
  await dialog.getByRole("button", { name: "규칙 저장", exact: true }).click();
  expect((await response).status()).toBe(409);
  await expect(dialog.getByRole("button", { name: "규칙 저장", exact: true })).toBeDisabled();
});
test("ROUTING-DRAFT-LIVE-003 조회 계정의 직접 초안 변경 거부", async ({ page }) => {
  await login(page, reader, "/app/routing/rules");
  await expect(page.getByRole("alert")).toContainText("접근 권한이 없습니다.");
  const status = await page.evaluate(async () => {
    const response = await fetch("/admin/routing-rules/browser-order-a?review=edit", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expected_revision: "a".repeat(64),
        patch: { target_model: "denied" },
        reason: "denied fixture",
      }),
    });
    return response.status;
  });
  expect(status).toBe(401);
});
