import { expect, type Page } from "@playwright/test";
import {
  accessPath,
  closeSecret,
  issueKey,
  keyRow,
  keysPath,
  matches,
  protectedChat,
} from "./access-fixture";
import { admin, login, reader, required, signIn, signOut, test } from "./live-fixture";

async function freshKeys(page: Page): Promise<void> {
  const response = page.waitForResponse((value) => matches(value, "GET", keysPath) && value.status() === 200);
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await response;
}
async function review(page: Page, name: string, id: string, reason: string) {
  await freshKeys(page);
  await keyRow(page, name).getByRole("button", { name: "폐기", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "API 키 폐기", exact: true });
  const confirm = dialog.getByRole("button", { name: "폐기", exact: true });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("textbox", { name: "확인 문구", exact: true }).fill(id);
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("textbox", { name: "변경 사유", exact: true }).fill(reason);
  await expect(confirm).toBeEnabled();
  return { dialog, confirm };
}

test("AUTH-LIVE-021 실제 검토 폐기와 읽기 전용 서버 거부", async ({ page }) => {
  await login(page, admin, accessPath);
  const name = "browser-admin-revoke";
  const key = await issueKey(page, name, ["chat:completion"]);
  await closeSecret(page);
  expect(await protectedChat(page, key.secret, "browser-access-model")).toBe(200);
  const { dialog, confirm } = await review(page, name, key.api_key.id, "browser-admin-reviewed-revoke");
  await expect(dialog.getByRole("checkbox", { name: /완전 삭제/ })).toHaveCount(0);
  const received = page.waitForResponse((r) => matches(r, "DELETE", `${keysPath}/${key.api_key.id}`));
  await confirm.click();
  expect((await received).status()).toBe(200);
  await expect(dialog).toBeHidden();
  expect(await protectedChat(page, key.secret, "browser-access-model")).toBe(401);
  await freshKeys(page);
  await expect(keyRow(page, name).getByRole("button", { name: "폐기", exact: true })).toBeDisabled();
  // Verify role enforcement through the real API, not only a disabled button.
  await signOut(page);
  await signIn(page, reader);
  await freshKeys(page);
  const denied = await page.evaluate(async (id) => {
    const headers = {
      Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
      "Content-Type": "application/json",
    };
    const result = await fetch(`/admin/api-keys/${id}`, { method: "DELETE", headers });
    await result.arrayBuffer();
    return result.status;
  }, key.api_key.id);
  expect(denied).toBe(401);
});

test("AUTH-LIVE-022 실제 폐기 커밋 후 응답 유실은 다시 전송하지 않는다", async ({ page }) => {
  await login(page, admin, accessPath);
  const name = "browser-admin-revoke-lost";
  const key = await issueKey(page, name, ["chat:completion"]);
  await closeSecret(page);
  const { dialog, confirm } = await review(page, name, key.api_key.id, "browser-admin-lost-revoke");
  const path = `${keysPath}/${key.api_key.id}`;
  let writes = 0;
  let committed = false;
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.continue();
      return;
    }
    writes++;
    const response = await route.fetch({ maxRetries: 0 });
    committed = response.status() === 200;
    await response.dispose();
    await route.abort("failed");
  });
  await confirm.click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(committed).toBe(true);
  expect(writes).toBe(1);
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await expect(keyRow(page, name).getByRole("button", { name: "폐기", exact: true })).toBeDisabled();
  await freshKeys(page);
  expect(writes).toBe(1);
  expect(await protectedChat(page, key.secret, "browser-access-model")).toBe(401);
});

test("AUTH-LIVE-023 실제 완전 삭제는 최고 관리자만 실행하며 요청 이력을 남긴다", async ({ page }) => {
  const superAdmin = {
    email: required("VIBE_AUTH_SUPER_EMAIL"),
    password: required("VIBE_AUTH_SUPER_PASSWORD"),
  };
  await login(page, superAdmin, accessPath);
  const name = "browser-admin-hard-delete";
  const key = await issueKey(page, name, ["chat:completion"]);
  await closeSecret(page);
  expect(await protectedChat(page, key.secret, "browser-access-model")).toBe(200);
  const { dialog, confirm } = await review(page, name, key.api_key.id, "browser-admin-reviewed-delete");
  await expect(dialog).toContainText("기존 요청·감사 이력과 교체 이력은 남으며");
  await dialog.getByRole("checkbox", { name: /완전 삭제/ }).check();
  const received = page.waitForResponse((r) => matches(r, "DELETE", `${keysPath}/${key.api_key.id}`));
  await confirm.click();
  const response = await received;
  expect(response.status()).toBe(200);
  expect(new URL(response.url()).searchParams.get("hard")).toBe("1");
  await expect(dialog).toBeHidden();
  await expect(keyRow(page, name)).toHaveCount(0);
  expect(await protectedChat(page, key.secret, "browser-access-model")).toBe(401);
});
