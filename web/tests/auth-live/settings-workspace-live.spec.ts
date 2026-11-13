import { expect } from "@playwright/test";
import { admin, login, reader, test } from "./live-fixture";

const key = "cache.chat_enabled";
const path = `/app/system/settings?tab=runtime&q=목록밖&setting=${key}`;

test("AUTH-LIVE-043 실제 설정 상세 주소·저장·새로고침·기본값 복구", async ({ page }) => {
  await login(page, admin, path);
  const sheet = page.getByRole("dialog", { name: key, exact: true });
  await expect(sheet).toBeVisible();
  const input = sheet.getByLabel("새 값", { exact: true });
  const next = (await input.inputValue()) === "true" ? "false" : "true";
  await input.selectOption(next);
  await sheet.getByLabel("변경 사유").fill("synthetic settings workspace validation");
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === `/admin/settings/by-key/${key}`,
  );
  await sheet.getByRole("button", { name: "저장", exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(200);
  const body: { value: string; expected_version?: number; reason: string } = response
    .request()
    .postDataJSON();
  expect(
    body.value === next &&
      Number.isSafeInteger(body.expected_version) &&
      body.reason === "synthetic settings workspace validation",
  ).toBe(true);
  await expect(sheet).toBeHidden();
  await page.goto(path);
  await expect(input).toHaveValue(next);
  await page.reload();
  await expect(input).toHaveValue(next);
  await sheet.getByRole("button", { name: "기본값(환경변수)으로 되돌리기", exact: true }).click();
  const restore = page.getByRole("dialog", { name: "환경변수 기본값으로 되돌리기", exact: true });
  await restore.getByLabel("변경 사유").fill("synthetic settings workspace cleanup");
  const reverted = page.waitForResponse(
    (result) =>
      result.request().method() === "DELETE" &&
      new URL(result.url()).pathname === `/admin/settings/by-key/${key}`,
  );
  await restore.getByRole("button", { name: "되돌리기", exact: true }).click();
  expect((await reverted).status()).toBe(200);
  await expect(restore).toBeHidden();
});

test("AUTH-LIVE-044 실제 조회 역할의 설정 상세와 서버 쓰기 거부", async ({ page }) => {
  await login(page, reader, path);
  const sheet = page.getByRole("dialog", { name: key, exact: true });
  await expect(sheet.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await expect(
    sheet.getByRole("button", { name: "기본값(환경변수)으로 되돌리기", exact: true }),
  ).toBeDisabled();
  const status = await page.evaluate(async () => {
    const response = await fetch("/admin/settings/by-key/cache.chat_enabled", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value: "true", expected_version: 0, reason: "must be denied" }),
    });
    return response.status;
  });
  expect(status).toBe(401);
});
