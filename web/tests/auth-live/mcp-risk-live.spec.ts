import { expect } from "@playwright/test";
import { admin, login, test } from "./live-fixture";

test("AUTH-LIVE-032 실제 MCP 도구 위험 설정 검토와 저장", async ({ page }) => {
  await login(page, admin, "/app/mcp?tab=tools&server=browser-risk-server&tool=write_record");
  await page
    .getByRole("button", { name: "browser-risk-server write_record 위험 등급 편집", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "도구 위험 등급", exact: true });
  const save = dialog.getByRole("button", { name: "검토한 변경 저장", exact: true });
  await expect(save).toBeDisabled();
  await dialog.getByLabel("위험 등급", { exact: false }).selectOption("critical");
  await dialog.getByLabel("메모", { exact: true }).fill("browser reviewed");
  await expect(dialog.getByText("변경 전: 높음", { exact: true })).toBeVisible();
  await expect(dialog.getByText("변경 후: 심각", { exact: true })).toBeVisible();
  const posted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/admin/mcp/tools" && response.request().method() === "POST",
  );
  await save.click();
  expect((await posted).status()).toBe(201);
  await expect(dialog).toHaveCount(0);
  const table = page.getByRole("table", { name: "MCP 도구 위험 등급", exact: true });
  await expect(table.getByText("심각", { exact: true })).toBeVisible();
  await page.reload();
  await expect(table.getByText("심각", { exact: true })).toBeVisible();
  // Go's harness separately verifies the stored row and exactly one audit event.
});
