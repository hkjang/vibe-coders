import { expect, type Page } from "@playwright/test";
import {
  accessPath,
  closeSecret,
  confirmKeyEdit,
  issueKey,
  keyRow,
  keysPath,
  matches,
  protectedChat,
} from "./access-fixture";
import { admin, login, test } from "./live-fixture";

async function openEdit(page: Page, name: string) {
  const loaded = page.waitForResponse((r) => matches(r, "GET", keysPath) && r.status() === 200);
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await loaded;
  await keyRow(page, name).getByRole("button", { name: "수정", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "API 키 수정", exact: true });
  const save = dialog.getByRole("button", { name: "검토한 변경 저장", exact: true });
  await expect(save).toBeDisabled();
  return { dialog, save };
}

test("AUTH-LIVE-024 실제 검토 정보 수정은 변경 필드와 사유를 저장하고 키 사용 중지를 적용한다", async ({
  page,
}) => {
  await login(page, admin, accessPath);
  const name = "browser-admin-edit";
  const key = await issueKey(page, name, ["chat:completion"]);
  await closeSecret(page);
  expect(await protectedChat(page, key.secret, "browser-access-model")).toBe(200);
  const { dialog, save } = await openEdit(page, name);
  await dialog.getByRole("textbox", { name: "이름", exact: true }).fill("browser-admin-edited");
  await dialog.getByRole("combobox", { name: "상태", exact: true }).selectOption("disabled");
  await expect(dialog.getByRole("region", { name: "변경 전후 비교", exact: true })).toContainText(name);
  await confirmKeyEdit(dialog, "browser-admin-reviewed-edit");
  const received = page.waitForResponse((r) => matches(r, "PATCH", `${keysPath}/${key.api_key.id}`));
  await save.click();
  const response = await received;
  expect(response.status()).toBe(200);
  const body: Record<string, unknown> = response.request().postDataJSON();
  expect(Object.keys(body).sort()).toEqual(["name", "review", "status"]);
  await expect(dialog).toBeHidden();
  expect(await protectedChat(page, key.secret, "browser-access-model")).toBe(401);
  await page.reload();
  await expect(keyRow(page, "browser-admin-edited")).toBeVisible();
});

test("AUTH-LIVE-025 검토 후 실제 다른 관리 변경이 있으면 저장을 거부하고 초안을 유지한다", async ({
  page,
}) => {
  await login(page, admin, accessPath);
  const name = "browser-admin-edit-conflict";
  const key = await issueKey(page, name, ["models:read"]);
  await closeSecret(page);
  const { dialog, save } = await openEdit(page, name);
  await dialog.getByRole("textbox", { name: "이름", exact: true }).fill("browser-admin-stale-edit");
  await confirmKeyEdit(dialog, "browser-admin-rejected-edit");
  const path = `${keysPath}/${key.api_key.id}`;
  const concurrent = await page.evaluate(async (path) => {
    const response = await fetch(path, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ owner: "browser-concurrent-owner" }),
    });
    await response.arrayBuffer();
    return response.status;
  }, path);
  expect(concurrent).toBe(200);
  const received = page.waitForResponse((r) => matches(r, "PATCH", path));
  await save.click();
  const response = await received;
  expect(response.status()).toBe(409);
  await expect(dialog.getByRole("alert")).toContainText("키 정보가 변경되어 저장하지 않았습니다");
  await expect(dialog.getByRole("textbox", { name: "이름", exact: true })).toHaveValue(
    "browser-admin-stale-edit",
  );
  await expect(save).toBeDisabled();
});

test("AUTH-LIVE-026 실제 정보 수정 커밋 후 응답 유실은 재전송하지 않는다", async ({ page }) => {
  await login(page, admin, accessPath);
  const name = "browser-admin-edit-lost";
  const key = await issueKey(page, name, ["models:read"]);
  await closeSecret(page);
  const { dialog, save } = await openEdit(page, name);
  await dialog.getByRole("textbox", { name: "소유자", exact: true }).fill("browser-reviewed-owner");
  await confirmKeyEdit(dialog, "browser-admin-lost-edit");
  let writes = 0;
  let committed = false;
  await page.route(`**${keysPath}/${key.api_key.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    writes++;
    const response = await route.fetch({ maxRetries: 0 });
    committed = response.status() === 200;
    await response.dispose();
    await route.abort("failed");
  });
  await save.click();
  await expect(dialog.getByRole("alert")).toContainText("재전송하지 말고 목록과 감사 이력");
  expect(committed).toBe(true);
  expect(writes).toBe(1);
  await expect(save).toBeDisabled();
  await dialog.locator("form").evaluate((form) => (form as HTMLFormElement).requestSubmit());
  expect(writes).toBe(1);
});
