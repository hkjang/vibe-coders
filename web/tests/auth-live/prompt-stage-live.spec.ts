import { expect } from "@playwright/test";
import type { PromptStageWorkspacePage, PromptStageChange } from "../../src/shared/api/generated";
import { admin, reader, login, test } from "./live-fixture";

test("AUTH-LIVE-055 실제 관리자 단계 변경·충돌과 감사 정합성", async ({ page }) => {
  const response = page.waitForResponse(
    (value) =>
      new URL(value.url()).pathname === "/admin/prompts/promotions" &&
      value.request().method() === "GET" &&
      value.status() === 200,
  );
  await login(page, admin, "/app/prompts/library?tab=promotions");
  const data: PromptStageWorkspacePage = await (await response).json();
  const row = data.items.find((value) => value.name === "browser-stage-edit");
  expect(Boolean(row)).toBe(true);
  if (!row) throw Error("Stage fixture missing");
  expect(JSON.stringify(data).includes("private-stage")).toBe(false);
  const tableRow = page
    .getByRole("row")
    .filter({ has: page.getByText("browser-stage-edit", { exact: true }) });
  await tableRow.getByRole("button", { name: "단계 변경", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "프롬프트 단계 변경" });
  await dialog.getByRole("combobox", { name: "변경할 단계" }).selectOption("validation");
  await dialog.getByRole("textbox", { name: "변경 사유" }).fill("브라우저 검증 완료");
  await dialog.getByRole("checkbox").check();
  const saved = page.waitForResponse(
    (value) =>
      new URL(value.url()).pathname === "/admin/prompts/promotions" && value.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "확인한 단계로 변경" }).click();
  expect((await saved).status()).toBe(200);
  await expect(dialog).toHaveCount(0);
  await expect(tableRow.getByText("검증", { exact: true })).toBeVisible();
  const payload: PromptStageChange = {
    name: row.name,
    version: row.version,
    revision: row.revision,
    stage: "production",
    reason: "동시 변경 확인",
  };
  const status = await page.evaluate(async (body) => {
    const response = await fetch("/admin/prompts/promotions?view=workspace", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
      },
      body: JSON.stringify(body),
    });
    return response.status;
  }, payload);
  expect(status).toBe(409);
  await page.reload();
  await expect(tableRow.getByText("검증", { exact: true })).toBeVisible();
});
test("AUTH-LIVE-056 실제 읽기 전용 관리자의 단계 조회와 변경 거부", async ({ page }) => {
  const response = page.waitForResponse(
    (value) =>
      new URL(value.url()).pathname === "/admin/prompts/promotions" &&
      value.request().method() === "GET" &&
      value.status() === 200,
  );
  await login(page, reader, "/app/prompts/library?tab=promotions");
  const data: PromptStageWorkspacePage = await (await response).json();
  const row = data.items.find((value) => value.name === "browser-stage-reader");
  expect(Boolean(row)).toBe(true);
  if (!row) throw Error("Stage fixture missing");
  const button = page
    .getByRole("row")
    .filter({ has: page.getByText("browser-stage-reader", { exact: true }) })
    .getByRole("button", { name: "단계 변경", exact: true });
  await expect(button).toBeDisabled();
  const status = await page.evaluate(
    async (body) => {
      const response = await fetch("/admin/prompts/promotions?view=workspace", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
        },
        body: JSON.stringify(body),
      });
      return response.status;
    },
    {
      name: row.name,
      version: row.version,
      revision: row.revision,
      stage: "production",
      reason: "거부 확인",
    },
  );
  expect(status === 401 || status === 403).toBe(true);
});
