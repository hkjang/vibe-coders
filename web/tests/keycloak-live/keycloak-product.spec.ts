import { expect, test as base, type Page } from "@playwright/test";

const gateway = "https://127.0.0.1:4187";
const idp = "https://127.0.0.2:8443";
const test = base.extend<{ networkBoundary: undefined }>({
  networkBoundary: [
    async ({ context }, use) => {
      let blocked = 0;
      await context.route("**/*", async (route) => {
        if ([gateway, idp].includes(new URL(route.request().url()).origin)) await route.continue();
        else {
          blocked += 1;
          await route.abort("blockedbyclient");
        }
      });
      await use(undefined);
      expect(blocked).toBe(0);
    },
    { auto: true },
  ],
});
const overview = "/app/overview?tab=usage&trend=30d";

async function signIn(page: Page, username: string, path = overview): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Keycloak SSO", exact: true }).click();
  await expect.poll(() => new URL(page.url()).origin).toBe(idp);
  const password = process.env.VIBE_KEYCLOAK_PASSWORD;
  if (!password) throw new Error("Synthetic product password is missing.");
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  await expect(page.getByLabel("사용자 메뉴")).toBeVisible();
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(path);
  expect(new URL(page.url()).hash).toBe("");
}

async function currentUser(page: Page): Promise<{ id?: string; role?: string }> {
  return page.evaluate(async () => {
    const response = await fetch("/auth/me", {
      headers: { Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}` },
    });
    const body: { user?: { id?: string; role?: string } } = await response.json();
    return body.user ?? {};
  });
}

test("KEYCLOAK-LIVE-001 HTTPS 자동 로그인 실패가 로그인 화면으로 한 번 복귀한다", async ({ page }) => {
  let silent = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === idp && url.pathname.endsWith("/auth") && url.searchParams.get("prompt") === "none")
      silent += 1;
  });
  await page.goto(overview);
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
  await expect.poll(() => silent).toBe(1);
  await expect(page).toHaveURL((url) => url.searchParams.get("sso") === "none");
  expect(new URL(page.url()).searchParams.get("return_to")).toBe(overview);
  expect(silent).toBe(1);
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
  await expect(page).toHaveURL((url) => url.searchParams.get("sso") === "none");
  expect(silent).toBe(1);
});

test("KEYCLOAK-LIVE-002 같은 이메일의 로컬 계정을 보존하고 별도 SSO 사용자로 복귀한다", async ({ page }) => {
  await signIn(page, "existing-operator");
  const user = await currentUser(page);
  expect(Boolean(user.id)).toBe(true);
  expect(user.id).not.toBe("existing-product-user");
  expect(user.role).toBe("admin");
  await expect(page.getByRole("heading", { name: "운영 개요", exact: true })).toBeVisible();
});

test("KEYCLOAK-LIVE-003 신규 계정을 만들고 새 탭에서 SSO 세션으로 복귀한다", async ({ page, context }) => {
  await signIn(page, "new-operator");
  const first = await currentUser(page);
  expect(Boolean(first.id)).toBe(true);
  expect(first.role).toBe("admin");
  const other = await context.newPage();
  let silent = 0;
  other.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === idp && url.searchParams.get("prompt") === "none") silent += 1;
  });
  await other.goto(overview);
  await expect(other.getByLabel("사용자 메뉴")).toBeVisible();
  expect(await currentUser(other)).toEqual(first);
  expect(new URL(other.url()).pathname + new URL(other.url()).search).toBe(overview);
  expect(silent).toBe(1);
});

test("KEYCLOAK-LIVE-004 HTTPS 로그아웃이 Keycloak 세션도 종료하고 복귀한다", async ({ page }) => {
  await signIn(page, "new-operator");
  const refresh = await page.evaluate(() => sessionStorage.getItem("vibe.app.auth.refresh") ?? "");
  await page.getByLabel("사용자 메뉴").click();
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect.poll(() => new URL(page.url()).origin).toBe(idp);
  // Without an ID-token hint, Keycloak deliberately asks for logout confirmation.
  await page.locator("#kc-logout").click();
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/app/login");
  expect(
    await page.evaluate(
      async (token) =>
        (
          await fetch("/auth/refresh", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refresh_token: token }),
          })
        ).status,
      refresh,
    ),
  ).toBe(401);
  await page.getByRole("button", { name: "Keycloak SSO", exact: true }).click();
  await expect(page.locator("#username")).toBeVisible();
});

test("KEYCLOAK-LIVE-005 실제 역할 클레임이 읽기 전용 권한으로 매핑된다", async ({ page }) => {
  await signIn(page, "reader");
  expect((await currentUser(page)).role).toBe("readonly_admin");
  const status = await page.evaluate(
    async () =>
      (
        await fetch("/admin/providers", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
  );
  expect(status).toBe(401);
});

test("KEYCLOAK-LIVE-006 공급자 상세가 독립된 Legacy SSO 로그인 후에도 유지된다", async ({ page }) => {
  await signIn(page, "new-operator");
  const ref = await page.evaluate(async () => {
    const response = await fetch("/admin/providers", {
      headers: {
        Authorization: "Bearer " + sessionStorage.getItem("vibe.app.auth.access"),
        "X-Vibe-UI": "app",
      },
    });
    const data: { providers: { provider_ref: string; name: string }[] } = await response.json();
    return data.providers.find((provider) => provider.name === "SSO +%2F?&# 공급자")?.provider_ref;
  });
  expect(ref).toMatch(/^prv_[A-Za-z0-9_-]{43}$/);
  if (!ref) throw new Error("Synthetic provider reference is missing.");
  const target = "#/settings?provider_ref=" + ref;
  await page.goto("/app/gateway/providers?provider=" + ref);
  const handoff = page.getByRole("link", { name: "기존 화면에서 같은 공급자 열기", exact: true });
  await expect(handoff).toHaveAttribute("href", "/admin" + target);
  expect(await page.evaluate(() => sessionStorage.getItem("authAccess"))).toBeNull();
  await handoff.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#login-backdrop.open")).toBeVisible();
  let writes = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/admin/providers") && request.method() !== "GET")
      writes += 1;
  });
  await page.getByRole("button", { name: "SSO 로그인 (Keycloak)", exact: true }).click();
  await expect(page.locator("#legacy-provider-detail")).toContainText("SSO +%2F?&# 공급자");
  await expect(page).toHaveURL(gateway + "/admin" + target);
  expect(await page.evaluate(() => sessionStorage.getItem("vibe.admin.auth.sso-return-to"))).toBeNull();
  await page.reload();
  await expect(page.locator("#legacy-provider-detail")).toContainText(ref);
  expect(writes).toBe(0);
});

test("KEYCLOAK-LIVE-007 읽기 전용 SSO가 요청 상세와 필터를 정확히 복원한다", async ({ page }) => {
  const requestID = "SSO 요청 +%2F?&#";
  const target =
    "#/requests?" +
    new URLSearchParams({
      request_id: requestID,
      model: "public-model",
      ip: "2001:db8::7",
      limit: "37",
    });
  await page.goto("/admin" + target);
  await expect(page.locator("#login-backdrop.open")).toBeVisible();
  await page.getByRole("button", { name: "SSO 로그인 (Keycloak)", exact: true }).click();
  await expect.poll(() => new URL(page.url()).origin).toBe(idp);
  expect(new URL(page.url()).searchParams.get("redirect_uri")).toBe(gateway + "/auth/keycloak/callback");
  const password = process.env.VIBE_KEYCLOAK_PASSWORD;
  if (!password) throw new Error("Synthetic product password is missing.");
  await page.locator("#username").fill("reader");
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  await expect(page.locator("#modal-backdrop.open")).toBeVisible();
  await expect(page.locator("#modal-body")).toContainText(requestID);
  await expect(page).toHaveURL((url) => url.pathname === "/admin" && url.hash.startsWith("#/requests?"));
  // Legacy rewrites query order when it loads the list; exact values must survive.
  expect(Object.fromEntries(new URLSearchParams(new URL(page.url()).hash.split("?")[1]))).toEqual({
    request_id: requestID,
    model: "public-model",
    ip: "2001:db8::7",
    limit: "37",
  });
  await expect(page.locator("#f-model")).toHaveValue("public-model");
  await expect(page.locator("#f-ip")).toHaveValue("2001:db8::7");
  await expect(page.locator("#f-limit")).toHaveValue("37");
  expect(await page.evaluate(() => sessionStorage.getItem("vibe.admin.auth.sso-return-to"))).toBeNull();
  const role = await page.evaluate(async () => {
    const response = await fetch("/auth/me", {
      headers: { Authorization: "Bearer " + sessionStorage.getItem("authAccess") },
    });
    const body: { user: { role: string } } = await response.json();
    return body.user.role;
  });
  expect(role).toBe("readonly_admin");
  expect(await page.evaluate(() => sessionStorage.getItem("vibe.app.auth.access"))).toBeNull();
});
