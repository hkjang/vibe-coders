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
  await page.goto("/app/mcp?tab=requests&server=browser-risk-server&tool=write_record");
  const details = page.getByRole("button", { name: "browser_mcp_risk 처리 흐름 열기", exact: true });
  await details.click();
  const flow = page.getByRole("dialog", { name: "MCP 요청 처리 흐름", exact: true });
  await expect(flow.getByText("호출 당시의 정책 기록과 구분하세요.", { exact: true })).toBeVisible();
  await expect(flow.getByRole("table", { name: "요청의 도구 호출", exact: true })).toContainText(
    "write_record",
  );
  await expect(flow.getByRole("table", { name: "MCP 요청 처리 단계", exact: true })).toContainText(
    "현재 서버 정책",
  );
  await page.reload();
  await expect(flow.getByRole("table", { name: "요청의 도구 호출", exact: true })).toContainText(
    "write_record",
  );
  await flow.getByRole("button", { name: "패널 닫기", exact: true }).click();
  await expect(details).toBeVisible();
  // Go's harness separately verifies the stored row and exactly one audit event.
});
