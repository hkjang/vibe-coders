import { expect, type Page } from "@playwright/test";
import { admin, login, reader, test } from "./live-fixture";

const path = "/app/system/settings?tab=changesets";
const title = "browser-changeset-lifecycle";

async function transition(
  page: Page,
  id: string,
  action: string,
  dialogTitle: string,
  suffix: string,
  typed = false,
) {
  const sheet = page.getByRole("dialog", { name: title, exact: true });
  await expect(sheet.getByRole("button", { name: action, exact: true })).toBeEnabled();
  await sheet.getByRole("button", { name: action, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: dialogTitle, exact: true });
  const confirm = dialog.getByRole("button", { name: action, exact: true });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("textbox", { name: "변경 사유", exact: true }).fill(`browser-changeset-${suffix}`);
  if (typed) {
    await expect(confirm).toBeDisabled();
    await dialog.getByRole("textbox", { name: "확인 문구", exact: true }).fill(id);
  }
  const received = page.waitForResponse(
    (response) =>
      response.request().method() === (suffix === "delete" ? "DELETE" : "POST") &&
      new URL(response.url()).pathname ===
        `/admin/change-sets/${id}${suffix === "delete" ? "" : `/${suffix}`}`,
  );
  await confirm.click();
  const response = await received;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toEqual({ note: `browser-changeset-${suffix}` });
  await expect(dialog).toBeHidden();
}

test("AUTH-LIVE-013 실제 변경 세트 생성·미리보기·승인·적용·되돌리기·삭제", async ({ page }) => {
  await login(page, admin, path);
  await page.getByRole("button", { name: "새 변경 세트", exact: true }).click();
  const create = page.getByRole("dialog", { name: "새 변경 세트", exact: true });
  await create.getByRole("textbox", { name: "제목", exact: true }).fill(title);
  await create
    .getByRole("textbox", { name: "변경 항목(JSON)", exact: true })
    .fill(JSON.stringify([{ kind: "setting", key: "retention.request_days", value: "45" }]));
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/admin/change-sets",
  );
  await create.getByRole("button", { name: "만들기", exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const result: { id?: string; status?: string } = await response.json();
  expect(Boolean(result.id) && result.status === "draft").toBe(true);
  const id = result.id ?? "";
  await expect(create).toBeHidden();
  await page.getByRole("button", { name: `${title} 상세`, exact: true }).click();
  const sheet = page.getByRole("dialog", { name: title, exact: true });
  await sheet.getByRole("button", { name: "미리보기", exact: true }).click();
  await expect(sheet.getByRole("heading", { name: "적용 미리보기", exact: true })).toBeVisible();
  await expect(
    sheet
      .getByRole("row")
      .filter({ has: page.getByRole("rowheader", { name: "retention.request_days", exact: true }) }),
  ).toContainText("45");
  await transition(page, id, "검토 제출", "검토를 요청할까요?", "submit");
  await transition(page, id, "승인", "변경 세트를 승인할까요?", "approve");
  await transition(page, id, "적용", "설정을 실제로 적용할까요?", "apply", true);
  await expect(sheet.getByText("적용됨", { exact: true })).toBeVisible();
  await transition(page, id, "되돌리기", "적용 전 값으로 되돌릴까요?", "rollback", true);
  await expect(sheet.getByText("되돌림 완료", { exact: true })).toBeVisible();
  await transition(page, id, "삭제", "변경 세트를 삭제할까요?", "delete", true);
  await expect(sheet).toBeHidden();
  await page.reload();
  await expect(page.getByRole("button", { name: `${title} 상세`, exact: true })).toBeHidden();
});

test("AUTH-LIVE-014 실제 조회 역할의 변경 세트 쓰기 거부", async ({ page }) => {
  await login(page, reader, path);
  await expect(page.getByRole("button", { name: "새 변경 세트", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "browser-changeset-readonly 상세", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "browser-changeset-readonly", exact: true });
  for (const name of ["검토 제출", "승인", "적용", "되돌리기", "삭제"])
    await expect(sheet.getByRole("button", { name, exact: true })).toBeDisabled();
  const statuses = await page.evaluate(async () => {
    const headers = {
      Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
      "Content-Type": "application/json",
    };
    const read = await fetch("/admin/change-sets", { headers });
    const write = await fetch("/admin/change-sets/browser-readonly-set/apply", {
      method: "POST",
      headers,
      body: JSON.stringify({ note: "must-be-denied" }),
    });
    return { read: read.status, write: write.status };
  });
  expect(statuses).toEqual({ read: 200, write: 401 });
});
