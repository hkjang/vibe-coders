import { expect, type Page, type Route } from "@playwright/test";

import { admin, login, providerPath, required, test } from "./live-fixture";

const chunkPath = required("VIBE_AUTH_PROVIDER_CHUNK");
if (!/^\/app\/assets\/ProviderPage-[A-Za-z0-9_-]{8,64}\.js$/u.test(chunkPath)) {
  throw new Error("Recovery requires the isolated harness's exact embedded provider page chunk.");
}

async function enterChunkFailure(page: Page): Promise<() => Promise<void>> {
  const target = new URL(chunkPath, required("APP_BASE_URL")).href;
  let requested = 0;
  let aborted = 0;
  let scriptOnly = true;
  page.on("request", (request) => {
    if (request.url() === target) requested += 1;
  });
  await login(page, admin, "/app/overview");
  // A fresh document has not evaluated or prefetched this lazy page. Do not
  // synthesize an exception or abort the shell/shared chunks to reach the UI.
  expect(requested).toBe(0);
  expect(await page.evaluate((url) => performance.getEntriesByName(url).length === 0, target)).toBe(true);
  const abort = async (route: Route): Promise<void> => {
    aborted += 1;
    scriptOnly &&= route.request().resourceType() === "script";
    await route.abort("failed");
  };
  await page.route(target, abort);
  const sidebar = page.getByRole("complementary", { name: "주 메뉴", exact: true });
  const group = sidebar.getByRole("button", { name: "AI 게이트웨이", exact: true });
  if ((await group.getAttribute("aria-expanded")) === "false") await group.click();
  await sidebar.locator(`a[href="${providerPath}"]`).click();
  const heading = page.getByRole("heading", { name: "화면 오류", exact: true });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  await expect(page.getByRole("alert")).toContainText("예기치 못한 화면 오류가 발생했습니다.");
  expect(requested === 1 && aborted === 1 && scriptOnly).toBe(true);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "다시 시도", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "기존 관리자 화면 열기", exact: true })).toBeFocused();
  return async () => {
    await page.unroute(target, abort);
  };
}

test("AUTH-LIVE-011 실제 청크 실패의 키보드 복구와 기존 관리자·API 독립 동작", async ({ page, context }) => {
  const removeFailure = await enterChunkFailure(page);

  // The error boundary is still on screen. Obtain a separate real, short-lived
  // API session in browser memory so the fixed 8s UI TTL is not a timing premise
  // for server availability. Never replace the UI session or return credentials.
  const service = await page.evaluate(async (account) => {
    const storedAccess = sessionStorage.getItem("vibe.app.auth.access");
    const storedRefresh = sessionStorage.getItem("vibe.app.auth.refresh");
    const loginResponse = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(account),
      cache: "no-store",
    });
    const session: { access_token?: string; refresh_token?: string; expires_in?: number } =
      await loginResponse.json();
    if (loginResponse.status !== 200 || !session.access_token || !session.refresh_token) {
      return {
        authenticated: false,
        providers: false,
        issued: false,
        chat: false,
        keyRevoked: false,
        revoked: false,
        uiUnchanged: false,
      };
    }
    const headers = { Authorization: `Bearer ${session.access_token}` };
    const providersResponse = await fetch("/admin/providers", {
      headers: { ...headers, "X-Vibe-UI": "app" },
      cache: "no-store",
    });
    const providers: { providers?: { name?: string }[] } = await providersResponse.json();
    // /v1 intentionally accepts API keys, not an administrator's login JWT.
    // Issue a disposable key through the real management API, use it only in
    // this closure, and revoke it before ending the independent probe session.
    const issuedResponse = await fetch("/admin/api-keys", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "synthetic route recovery key",
        role: "developer",
        scopes: ["chat:completion"],
      }),
    });
    const issued: { secret?: string; api_key?: { id?: string } } = await issuedResponse.json();
    if (issuedResponse.status !== 201 || !issued.secret || !issued.api_key?.id) {
      throw new Error("The isolated recovery probe key was not issued.");
    }
    const chatResponse = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${issued.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "browser-access-model",
        messages: [{ role: "user", content: "synthetic route recovery check" }],
      }),
    });
    const chat: { id?: string; choices?: { message?: { content?: string } }[] } = await chatResponse.json();
    const keyRevokedResponse = await fetch(
      `/admin/api-keys/${encodeURIComponent(issued.api_key.id)}/revoke`,
      {
        method: "POST",
        headers,
      },
    );
    const keyRevoked: { id?: string; status?: string } = await keyRevokedResponse.json();
    const logoutResponse = await fetch("/auth/logout", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    return {
      authenticated: session.expires_in === 8,
      issued: issuedResponse.status === 201,
      providers:
        providersResponse.status === 200 && providers.providers?.some((row) => row.name === "test") === true,
      chat:
        chatResponse.status === 200 &&
        chat.id === "synthetic-access-response" &&
        chat.choices?.[0]?.message?.content === "synthetic access response",
      keyRevoked:
        keyRevokedResponse.status === 200 &&
        keyRevoked.status === "revoked" &&
        keyRevoked.id === issued.api_key.id,
      revoked: logoutResponse.status === 200,
      uiUnchanged:
        storedAccess === sessionStorage.getItem("vibe.app.auth.access") &&
        storedRefresh === sessionStorage.getItem("vibe.app.auth.refresh"),
    };
  }, admin);
  expect(service.authenticated).toBe(true);
  expect(service.providers).toBe(true);
  expect(service.issued).toBe(true);
  expect(service.chat).toBe(true);
  expect(service.keyRevoked).toBe(true);
  expect(service.revoked && service.uiUnchanged).toBe(true);
  await expect(page.getByRole("heading", { name: "화면 오류", exact: true })).toBeVisible();
  await removeFailure();
  const recoveredRead = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/admin/providers" &&
      response.status() === 200,
  );
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "다시 시도", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  expect((await (await recoveredRead).finished()) === null).toBe(true);
  await expect(page.getByRole("heading", { name: "공급자", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "test", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "화면 오류", exact: true })).toBeHidden();

  // A separate fresh document has its own empty sessionStorage and module map.
  // The Legacy console does not consume React's credential storage keys.
  const legacy = await context.newPage();
  try {
    const removeLegacyFailure = await enterChunkFailure(legacy);
    expect(await legacy.evaluate(() => !sessionStorage.getItem("authAccess"))).toBe(true);
    await legacy.getByRole("link", { name: "기존 관리자 화면 열기", exact: true }).click();
    expect(new URL(legacy.url()).pathname === "/admin").toBe(true);
    const form = legacy.locator("#login-form");
    await expect(form).toBeVisible();
    await form.getByLabel("이메일", { exact: true }).fill(admin.email);
    await form.getByLabel("비밀번호", { exact: true }).fill(admin.password);
    const authenticated = legacy.waitForResponse(
      (response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === "/auth/login",
    );
    await form.getByRole("button", { name: "로그인", exact: true }).click();
    const loginResponse = await authenticated;
    expect(loginResponse.status()).toBe(200);
    expect((await loginResponse.finished()) === null).toBe(true);
    await expect(legacy.locator("#login-backdrop")).toBeHidden();
    await expect(legacy.locator("#auth-user")).toBeVisible();
    const providersRead = legacy.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/admin/providers" &&
        response.status() === 200,
    );
    await legacy.locator('#tabs a[data-tab="settings"]').click();
    const response = await providersRead;
    expect((await response.finished()) === null).toBe(true);
    const data: { providers?: { name?: string }[] } = await response.json();
    expect(data.providers?.some((row) => row.name === "test") === true).toBe(true);
    const list = legacy.locator("#settings-providers");
    await expect(list).toBeVisible();
    await expect(list.getByRole("cell", { name: "test", exact: true })).toBeVisible();
    await removeLegacyFailure();
  } finally {
    await legacy.close();
  }
});
