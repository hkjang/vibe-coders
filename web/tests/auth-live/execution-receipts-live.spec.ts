import { expect, type Page } from "@playwright/test";
import { admin, signIn, reader, test } from "./live-fixture";

async function receiptLogin(page: Page, account: typeof admin, path: string) {
  await page.goto(path);
  await signIn(page, account);
}

test("AUTH-LIVE-039 실제 워크플로 영수증 직접 로그인·새로고침·단계 상태", async ({ page }) => {
  const id = "browser-workflow-receipt-owner";
  await receiptLogin(page, admin, `/app/agents/workflows?tab=runs&run=${id}`);
  const dialog = page.getByRole("dialog", { name: "워크플로 실행 영수증", exact: true });
  await expect(dialog).toContainText("영수증 검증 업무");
  await expect(dialog.getByRole("cell", { name: "승인 대기", exact: true })).toBeVisible();
  await expect(dialog.getByRole("cell", { name: "건너뜀", exact: true })).toBeVisible();
  await expect(dialog.getByRole("cell", { name: "MCP 도구", exact: true })).toBeVisible();
  await page.reload();
  await expect(dialog).toContainText("영수증 검증 업무");
  expect(new URL(page.url()).searchParams.get("run")).toBe(id);
  await dialog.getByRole("button", { name: "대화상자 닫기", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("run")).toBe(false);
  await page.getByRole("link", { name: `실행 ${id} 영수증 보기`, exact: true }).click();
  await expect(dialog).toContainText("영수증 검증 업무");
});

test("AUTH-LIVE-040 실제 업무 앱 영수증 한글 요약·해시와 직접 주소", async ({ page }) => {
  await receiptLogin(page, admin, "/app/agents/apps?tab=runs&run=browser-app-receipt-owner");
  const dialog = page.getByRole("dialog", { name: "업무 앱 실행 영수증", exact: true });
  await expect(dialog).toContainText("영수증 검증 앱");
  await expect(dialog).toContainText("구성 요소 2개 계획됨");
  await expect(dialog).toContainText("입력 해시");
  await expect(dialog).not.toContainText("isolated-receipt-input-never-displayed");
  await page.reload();
  await expect(dialog).toContainText("구성 요소 2개 계획됨");
});

test("AUTH-LIVE-041 다른 사람의 실행은 관리자에게도 실제 API에서 거부한다", async ({ page }) => {
  const denied = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/v1/workflow-runs/browser-workflow-receipt-other/receipt",
  );
  await receiptLogin(page, admin, "/app/agents/workflows?tab=runs&run=browser-workflow-receipt-other");
  expect((await denied).status()).toBe(403);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText(
    "워크플로 조회 권한이 없거나 인증 상태가 변경되었습니다.",
  );
  const status = await page.evaluate(async () => {
    const response = await fetch("/v1/app-runs/browser-app-receipt-other/receipt", {
      headers: { Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}` },
    });
    return response.status;
  });
  expect(status).toBe(403);
});

test("AUTH-LIVE-042 조회 전용 계정은 자신의 앱 영수증을 직접 열 수 있다", async ({ page }) => {
  await receiptLogin(page, reader, "/app/agents/apps?tab=runs&run=browser-app-receipt-other");
  const dialog = page.getByRole("dialog", { name: "업무 앱 실행 영수증", exact: true });
  await expect(dialog).toContainText("영수증 검증 앱");
  await expect(dialog).toContainText("구성 요소 2개 계획됨");
  const absent = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/v1/app-runs/receipt-not-present/receipt",
  );
  await page.goto("/app/agents/apps?tab=runs&run=receipt-not-present");
  expect((await absent).status()).toBe(404);
  await expect(dialog).toContainText("실행 영수증을 찾을 수 없습니다.");
});
