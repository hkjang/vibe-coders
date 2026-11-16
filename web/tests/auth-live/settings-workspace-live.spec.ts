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

test("AUTH-LIVE-045 실제 설정 검색·콘솔 상세 주소·읽기 권한", async ({ page }) => {
  await login(page, reader, "/app/system/settings?tab=runtime");
  for (const key of ["cache.chat_enabled", "ui.app.enabled", "ui.app.feature.system.settings.rollout"]) {
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "명령 팔레트", exact: true });
    await palette.getByRole("button", { name: "자원 검색", exact: true }).click();
    const search = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/admin/resource-search",
    );
    await palette.getByRole("combobox").fill(key);
    expect((await search).status()).toBe(200);
    await expect(palette.getByRole("option").filter({ hasText: `시스템 설정 · ${key}` })).toBeVisible();
    await palette.getByRole("combobox").press("Enter");
    await expect(page).toHaveURL(new RegExp(`setting=${key.replaceAll(".", "\\.")}`));
    const name = key.includes(".feature.") ? "시스템 설정 전환 설정" : key;
    const dialog = page.getByRole("dialog", { name, exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
    await page.reload();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
});

test("AUTH-LIVE-046 실제 종류 선택 검색·읽기 전용 상세·팔레트 상태 초기화", async ({ page }) => {
  await login(page, reader, "/app/system/settings?tab=runtime");
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "명령 팔레트", exact: true });
  await palette.getByRole("button", { name: "자원 검색", exact: true }).click();
  await palette.getByRole("button", { name: "검색 대상: 전체 자원" }).click();
  await palette
    .getByRole("group", { name: "검색할 자원 종류" })
    .getByRole("button", { name: "시스템 설정", exact: true })
    .click();
  const input = palette.getByRole("combobox");
  await expect(input).toBeFocused();
  const searched = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/admin/resource-search",
  );
  await input.fill(key);
  const response = await searched;
  expect(response.status()).toBe(200);
  const body: { kinds: string[]; query: string } = response.request().postDataJSON();
  expect(body.kinds.length === 1 && body.kinds[0] === "setting" && body.query === key).toBe(true);
  await expect(palette.getByRole("option")).toHaveCount(1);
  await input.press("Enter");
  const detail = page.getByRole("dialog", { name: key, exact: true });
  await expect(detail.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await page.keyboard.press("Control+k");
  await palette.getByRole("button", { name: "자원 검색", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(palette.getByRole("button", { name: "검색 대상: 전체 자원" })).toBeVisible();
});
