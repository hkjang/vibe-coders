import { expect } from "@playwright/test";

import {
  accessPath,
  closeSecret,
  editScopes,
  issueKey,
  keyRow,
  keysPath,
  matches,
  prepareIssue,
  protectedChat,
  publicKeyCheck,
  saveScopes,
  scopeTitle,
  secretIsAbsent,
  watchLateAccessReads,
  type IssuedKey,
} from "./access-fixture";
import { admin, currentRole, login, reader, sessionIsEmpty, signIn, signOut, test } from "./live-fixture";

// Every request below reaches the actual Go Routes and temporary SQLite DB.
// Delays hold an already-committed real response, never a fabricated success.
test("AUTH-LIVE-006 실제 발급 비밀값 일회 표시와 공개 목록", async ({ page }) => {
  await login(page, admin, accessPath);
  const name = "browser-access-issued-once";
  // No selection on issuance omits scopes; only creation uses role defaults.
  const issued = await issueKey(page, name, []);
  const defaults = [
    "chat:completion",
    "embeddings:create",
    "models:read",
    "routing:read",
    "observability:read",
    "costs:read",
    "mcp:use",
  ];
  expect(JSON.stringify([...issued.api_key.scopes].sort()) === JSON.stringify(defaults.sort())).toBe(true);
  await publicKeyCheck(page, issued.api_key.id, issued.secret, issued.api_key.scopes);
  await closeSecret(page);
  expect(await secretIsAbsent(page, issued.secret)).toBe(true);
  await page.reload();
  await expect(keyRow(page, name)).toBeVisible();
  expect(await secretIsAbsent(page, issued.secret)).toBe(true);
  await signOut(page);
  expect(await sessionIsEmpty(page)).toBe(true);
  expect(await secretIsAbsent(page, issued.secret)).toBe(true);
  await signIn(page);
  await expect(keyRow(page, name)).toBeVisible();
  await publicKeyCheck(page, issued.api_key.id, issued.secret);
  expect(await secretIsAbsent(page, issued.secret)).toBe(true);
});

test("AUTH-LIVE-007 실제 권한 저장·전체 해제·보호된 대화 호출 거부와 복구", async ({ page }) => {
  await login(page, admin, accessPath);
  const name = "browser-access-scope-roundtrip";
  const issued = await issueKey(page, name, ["chat:completion", "models:read"]);
  await closeSecret(page);
  expect(await protectedChat(page, issued.secret, "browser-access-model")).toBe(200);
  let dialog = await editScopes(page, name);
  await dialog.getByRole("checkbox", { name: /chat:completion/ }).uncheck();
  await dialog.getByRole("checkbox", { name: /models:read/ }).uncheck();
  await expect(dialog.getByText("현재 선택: 선택된 권한 없음", { exact: true })).toBeVisible();
  await saveScopes(page, dialog, issued.api_key.id, []);
  await publicKeyCheck(page, issued.api_key.id, issued.secret, []);
  // /v1/models allows anonymous reads and cannot prove a scope denial. The
  // harness additionally asserts this denied model NEVER reaches its upstream.
  expect(await protectedChat(page, issued.secret, "browser-access-denied-model")).toBe(401);
  await page.reload();
  await expect(keyRow(page, name).getByText("선택된 권한 없음", { exact: true })).toBeVisible();
  dialog = await editScopes(page, name);
  await expect(dialog.getByRole("checkbox", { name: /chat:completion/ })).not.toBeChecked();
  await dialog.getByRole("checkbox", { name: /chat:completion/ }).check();
  await saveScopes(page, dialog, issued.api_key.id, ["chat:completion"]);
  expect(await protectedChat(page, issued.secret, "browser-access-model")).toBe(200);
  await page.reload();
  await expect(keyRow(page, name)).toBeVisible();
  await publicKeyCheck(page, issued.api_key.id, issued.secret, ["chat:completion"]);
  expect(await secretIsAbsent(page, issued.secret)).toBe(true);
});

test("AUTH-LIVE-008 읽기 전용 관리자의 UI와 실제 발급·수정 거부", async ({ page }) => {
  await login(page, admin, accessPath);
  const name = "browser-access-readonly-target";
  const issued = await issueKey(page, name, ["models:read"]);
  await closeSecret(page);
  await signOut(page);
  await signIn(page, reader);
  expect(await currentRole(page)).toBe("readonly_admin");
  await expect(page.getByRole("button", { name: "키 발급", exact: true })).toBeDisabled();
  const row = keyRow(page, name);
  await expect(row.getByRole("button", { name: "권한 수정", exact: true })).toBeDisabled();
  await expect(row.getByRole("button", { name: "수정", exact: true })).toBeDisabled();
  await expect(row.getByRole("button", { name: "폐기", exact: true })).toBeDisabled();
  const result = await page.evaluate(async (id) => {
    const headers = {
      Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
      "Content-Type": "application/json",
    };
    const before = await fetch("/admin/api-keys", { headers });
    const original = await before.text();
    const created = await fetch("/admin/api-keys", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "browser-access-denied-creation",
        role: "developer",
        scopes: ["models:read"],
      }),
    });
    const updated = await fetch(`/admin/api-keys/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "browser-access-denied-edit", scopes: [] }),
    });
    const after = await fetch("/admin/api-keys", { headers });
    return {
      read: before.status,
      create: created.status,
      update: updated.status,
      reread: after.status,
      unchanged: original === (await after.text()),
    };
  }, issued.api_key.id);
  expect(result).toEqual({ read: 200, create: 401, update: 401, reread: 200, unchanged: true });
  await publicKeyCheck(page, issued.api_key.id, issued.secret, ["models:read"]);
  expect(await secretIsAbsent(page, issued.secret)).toBe(true);
});

test("AUTH-LIVE-009 실제 발급 완료의 늦은 응답과 새 계정 비밀값 격리", async ({ page, context }) => {
  await login(page, admin, accessPath);
  const other = await context.newPage();
  await login(other, admin, accessPath);
  await page.bringToFront();
  const sameDocument = await page.evaluate(() => performance.timeOrigin);
  const name = "browser-access-late-issuance";
  let issued: IssuedKey | undefined;
  let release = (): void => undefined;
  let delivered = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/admin/api-keys", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    issued = (await response.json()) as IssuedKey;
    await gate;
    await route.fulfill({ response });
    delivered = true;
  });
  try {
    const dialog = await prepareIssue(page, name, ["chat:completion"]);
    await dialog.getByRole("button", { name: "발급", exact: true }).click();
    await expect.poll(() => Boolean(issued?.secret && issued.api_key.id)).toBe(true);
    await expect(dialog.getByRole("button", { name: "저장 중", exact: true })).toBeDisabled();
    await signOut(other);
    await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
    expect(await sessionIsEmpty(page)).toBe(true);
    await expect(dialog).toBeHidden();
    await signIn(page, reader);
    expect(await currentRole(page)).toBe("readonly_admin");
    await expect(keyRow(page, name)).toBeVisible();
    const staleReads = watchLateAccessReads(page);
    const received = page.waitForResponse((response) => matches(response, "POST", keysPath));
    release();
    try {
      const response = await received;
      expect(response.status()).toBe(201);
      await expect.poll(() => delivered).toBe(true);
      await staleReads.assertSettled(response);
    } finally {
      staleReads.stop();
    }
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(sameDocument);
    expect(Boolean(issued)).toBe(true);
    if (!issued) throw new Error("The actual issuance response was not captured");
    expect(await secretIsAbsent(page, issued.secret)).toBe(true);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "키 발급", exact: true })).toBeDisabled();
    expect(await currentRole(page)).toBe("readonly_admin");
    // The server already committed the key. Seeing its public row is allowed;
    // client session isolation does not cancel or roll back that write.
    await expect(keyRow(page, name)).toBeVisible();
    await publicKeyCheck(page, issued.api_key.id, issued.secret, ["chat:completion"]);
  } finally {
    release();
  }
});

test("AUTH-LIVE-010 실제 권한 저장 완료의 늦은 응답과 이전 계정 초안 폐기", async ({ page, context }) => {
  await login(page, admin, accessPath);
  const name = "browser-access-late-scope-update";
  const issued = await issueKey(page, name, ["models:read"]);
  await closeSecret(page);
  const other = await context.newPage();
  await login(other, admin, accessPath);
  await page.bringToFront();
  const sameDocument = await page.evaluate(() => performance.timeOrigin);
  let ready = false;
  let delivered = false;
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const path = `${keysPath}/${issued.api_key.id}`;
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    const body: { scopes?: string[] } = route.request().postDataJSON();
    expect(JSON.stringify(body.scopes) === JSON.stringify(["chat:completion", "models:read"])).toBe(true);
    ready = true;
    await gate;
    await route.fulfill({ response });
    delivered = true;
  });
  try {
    const dialog = await editScopes(page, name);
    await dialog.getByRole("checkbox", { name: /chat:completion/ }).check();
    await dialog.getByRole("button", { name: "권한 저장", exact: true }).click();
    await expect.poll(() => ready).toBe(true);
    await expect(dialog.getByRole("checkbox", { name: /chat:completion/ })).toBeDisabled();
    await signOut(other);
    await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
    expect(await sessionIsEmpty(page)).toBe(true);
    await expect(page.getByRole("dialog", { name: scopeTitle, exact: true })).toBeHidden();
    await signIn(page, reader);
    expect(await currentRole(page)).toBe("readonly_admin");
    await expect(keyRow(page, name)).toBeVisible();
    const staleReads = watchLateAccessReads(page);
    const received = page.waitForResponse((response) => matches(response, "PATCH", path));
    release();
    try {
      const response = await received;
      expect(response.status()).toBe(200);
      await expect.poll(() => delivered).toBe(true);
      await staleReads.assertSettled(response);
    } finally {
      staleReads.stop();
    }
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(sameDocument);
    expect(await secretIsAbsent(page, issued.secret)).toBe(true);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    await expect(keyRow(page, name).getByRole("button", { name: "권한 수정", exact: true })).toBeDisabled();
    expect(await currentRole(page)).toBe("readonly_admin");
    // The write completed at Go before logout. Only its old-client continuation
    // is discarded; the readonly account may legitimately read committed scopes.
    await publicKeyCheck(page, issued.api_key.id, issued.secret, ["chat:completion", "models:read"]);
  } finally {
    release();
  }
});
