import { expect, test as base, type Page, type Request, type Response } from "@playwright/test";

// All authentication and application responses come from the actual Go Routes
// and isolated database. The one delayed response below is forwarded unchanged;
// no API response body/status or authentication token is fabricated.
const required = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing isolated harness input: ${key}`);
  return value;
};
const admin = {
  email: required("VIBE_AUTH_ADMIN_EMAIL"),
  password: required("VIBE_AUTH_ADMIN_PASSWORD"),
};
const reader = {
  email: required("VIBE_AUTH_READONLY_EMAIL"),
  password: required("VIBE_AUTH_READONLY_PASSWORD"),
};
const providerPath = "/app/gateway/providers";
const authKeys = ["vibe.app.auth.access", "vibe.app.auth.refresh", "vibe.app.auth.legacy-admin"];

const test = base.extend<{ isolatedNetwork: undefined }>({
  isolatedNetwork: [
    async ({ context, baseURL }, use) => {
      const origins = new Set([
        new URL(baseURL ?? required("APP_BASE_URL")).origin,
        new URL(required("VIBE_AUTH_IDP_ORIGIN")).origin,
      ]);
      let blocked = 0;
      await context.route("**/*", async (route) => {
        if (origins.has(new URL(route.request().url()).origin)) await route.continue();
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

async function signIn(page: Page, account = admin): Promise<void> {
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
  await page.getByLabel("이메일", { exact: true }).fill(account.email);
  await page.getByLabel("비밀번호", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByLabel("사용자 메뉴")).toBeVisible();
}

async function login(page: Page, account = admin, path = providerPath): Promise<void> {
  await page.goto(path);
  await signIn(page, account);
  await page.getByLabel("자동 새로고침 간격").selectOption("0");
}

async function signOut(page: Page): Promise<void> {
  await page.getByLabel("사용자 메뉴").click();
  const response = page.waitForResponse(
    (value) =>
      value.request().method() === "POST" && new URL(value.url()).pathname === "/auth/keycloak/logout",
  );
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  expect((await response).ok()).toBe(true);
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
}

async function sessionIsEmpty(page: Page): Promise<boolean> {
  return page.evaluate((keys) => keys.every((key) => !sessionStorage.getItem(key)), authKeys);
}

async function currentRole(page: Page): Promise<string | undefined> {
  return page.evaluate(async () => {
    const response = await fetch("/auth/me", {
      headers: { Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}` },
    });
    const data: { user?: { role?: string } } = await response.json();
    return data.user?.role;
  });
}

async function refreshStatus(page: Page, refresh: string): Promise<number> {
  return page.evaluate(async (token) => {
    const response = await fetch("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: token }),
    });
    return response.status;
  }, refresh);
}

test("AUTH-LIVE-001 실제 로그인·딥 링크·역할과 서버 쓰기 권한", async ({ page }) => {
  await page.goto(providerPath);
  await page.getByLabel("이메일", { exact: true }).fill(admin.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("synthetic-intentionally-wrong-password");
  const rejected = page.waitForResponse((response) => new URL(response.url()).pathname === "/auth/login");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  expect((await rejected).status()).toBe(401);
  await expect(page.getByRole("alert")).toBeVisible();
  await signIn(page);
  await expect(page.getByRole("heading", { name: "공급자", exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(providerPath);
  await expect(page.getByRole("button", { name: "공급자 추가", exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole("heading", { name: "공급자", exact: true })).toBeVisible();
  expect(await currentRole(page)).toBe("admin");
  await signOut(page);
  await signIn(page, reader);
  expect(await currentRole(page)).toBe("readonly_admin");
  await expect(
    page.getByRole("heading", { name: "이 기능은 안정 운영 화면에서 제공됩니다.", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "공급자 추가", exact: true })).toBeHidden();
  const status = await page.evaluate(async () => {
    const headers = {
      Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
      "Content-Type": "application/json",
    };
    const read = await fetch("/admin/providers", { headers });
    const write = await fetch("/admin/providers", { method: "POST", headers, body: "{}" });
    return { read: read.status, write: write.status };
  });
  // Existing admin handlers report insufficient write scope as 401, not 403.
  // This lane verifies denial without silently changing that server contract.
  expect(status).toEqual({ read: 200, write: 401 });
  await signOut(page);
  expect(await sessionIsEmpty(page)).toBe(true);
});

test("AUTH-LIVE-002 실제 OIDC·일회 교환·원래 경로 복귀", async ({ page }) => {
  const path = `${providerPath}?status=enabled`;
  await page.goto(path);
  await page.getByRole("button", { name: "Keycloak SSO", exact: true }).click();
  await page.getByLabel("이메일", { exact: true }).fill(required("VIBE_AUTH_SSO_EMAIL"));
  await page.getByLabel("비밀번호", { exact: true }).fill(required("VIBE_AUTH_SSO_PASSWORD"));
  const callback = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/auth/keycloak/callback",
  );
  await page.getByRole("button", { name: "테스트 계정으로 로그인", exact: true }).click();
  const location = await (await callback).headerValue("location");
  const code = new URLSearchParams(new URL(location ?? "", page.url()).hash.slice(1)).get("kc_code");
  expect(Boolean(code)).toBe(true);
  await expect(page.getByRole("heading", { name: "공급자", exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(path);
  expect(new URL(page.url()).hash).toBe("");
  expect(await currentRole(page)).toBe("admin");
  // Restore only this synthetic exchange's browser binding. Without it, a 401
  // would prove the missing-cookie guard, not server-side one-time consumption.
  await page.context().addCookies([
    {
      name: "vibe_sso_exchange",
      value: code ?? "",
      domain: new URL(page.url()).hostname,
      path: "/auth/sso/exchange",
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const replay = await page.evaluate(async (oneTimeCode) => {
    const response = await fetch("/auth/sso/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: oneTimeCode }),
    });
    return response.status;
  }, code);
  expect(replay).toBe(401);
  const externalReturn = await page.evaluate(async () => {
    const response = await fetch("/auth/keycloak/login?return_to=https%3A%2F%2Fexample.invalid%2F", {
      redirect: "manual",
    });
    return response.status;
  });
  expect(externalReturn).toBe(400);
});

test("AUTH-LIVE-003 실제 토큰 만료·동시 401·단일 갱신과 이전 토큰 폐기", async ({ page }) => {
  await login(page);
  await expect(page.getByRole("button", { name: "새로고침", exact: true })).toBeEnabled();
  const oldRefresh = await page.evaluate(() => sessionStorage.getItem("vibe.app.auth.refresh") ?? "");
  expect(Boolean(oldRefresh)).toBe(true);
  const ttl = Number(required("VIBE_AUTH_ACCESS_TTL_SECONDS"));
  expect(ttl > 0 && ttl <= 15).toBe(true);
  // Go validates the real server clock; browser clock mocking cannot expire JWTs.
  await new Promise((resolve) => setTimeout(resolve, (ttl + 1) * 1_000));
  let refreshes = 0;
  let refreshAttempts = 0;
  let unauthorized = 0;
  const collectRequest = (request: Request): void => {
    if (new URL(request.url()).pathname === "/auth/refresh") refreshAttempts += 1;
  };
  const collect = (response: Response): void => {
    const path = new URL(response.url()).pathname;
    if (path === "/auth/refresh" && response.ok()) refreshes += 1;
    if (path.startsWith("/admin/") && response.status() === 401) unauthorized += 1;
  };
  page.on("request", collectRequest);
  page.on("response", collect);
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect.poll(() => refreshes).toBe(1);
  await expect(page.getByRole("button", { name: "새로고침", exact: true })).toBeEnabled();
  expect(unauthorized).toBeGreaterThanOrEqual(2);
  expect(refreshes).toBe(1);
  expect(refreshAttempts).toBe(1);
  page.off("request", collectRequest);
  page.off("response", collect);
  expect(await currentRole(page)).toBe("admin");
  expect(await refreshStatus(page, oldRefresh)).toBe(401);
});

test("AUTH-LIVE-004 다른 탭 로그아웃·새 계정과 늦은 실제 응답 격리", async ({ page, context }) => {
  await login(page);
  const other = await context.newPage();
  await login(other);
  const revokedRefresh = await other.evaluate(() => sessionStorage.getItem("vibe.app.auth.refresh") ?? "");
  let release = (): void => undefined;
  let ready = false;
  let delivered = false;
  let holdNext = true;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/admin/ui-bootstrap", async (route) => {
    if (!holdNext) return route.fallback();
    holdNext = false;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    const previous: { user?: { role?: string } } = await response.json();
    expect(previous.user?.role === "admin").toBe(true);
    ready = true;
    await gate;
    await route.fulfill({ response });
    delivered = true;
  });
  await page.bringToFront();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => ready).toBe(true);
  try {
    await signOut(other);
    await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
    expect(await sessionIsEmpty(page)).toBe(true);
    expect(await sessionIsEmpty(other)).toBe(true);
    expect(await refreshStatus(other, revokedRefresh)).toBe(401);
    // Stay in the same document: a full navigation would cancel the old response.
    await signIn(page, reader);
    expect(await currentRole(page)).toBe("readonly_admin");
    const deliveredResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/admin/ui-bootstrap",
    );
    release();
    await expect.poll(() => delivered).toBe(true);
    // The client rejects the old session immediately after fetch resolves,
    // before consuming its JSON body. Verify arrival, not body consumption.
    expect((await deliveredResponse).status()).toBe(200);
    await page.getByLabel("사용자 메뉴").click();
    await expect(page.getByText("역할: 읽기 전용 관리자", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "공급자 추가", exact: true })).toBeHidden();
    expect(await currentRole(page)).toBe("readonly_admin");
  } finally {
    release();
  }
});

test("AUTH-LIVE-005 실제 갱신 거부 뒤 로그인 복귀와 재로그인", async ({ page }) => {
  await login(page);
  // Revoke through the existing server API without invoking the UI logout or
  // changing browser credentials. The client must discover the failed refresh.
  const revoked = await page.evaluate(async () => {
    const response = await fetch("/auth/keycloak/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        refresh_token: sessionStorage.getItem("vibe.app.auth.refresh"),
        return_to: "/app/login",
      }),
    });
    return response.status;
  });
  expect(revoked).toBe(200);
  expect(await sessionIsEmpty(page)).toBe(false);
  const ttl = Number(required("VIBE_AUTH_ACCESS_TTL_SECONDS"));
  expect(ttl > 0 && ttl <= 15).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, (ttl + 1) * 1_000));
  let refreshAttempts = 0;
  const collectRequest = (request: Request): void => {
    if (new URL(request.url()).pathname === "/auth/refresh") refreshAttempts += 1;
  };
  page.on("request", collectRequest);
  const failedRefresh = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/auth/refresh",
  );
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  expect((await failedRefresh).status()).toBe(401);
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
  expect(refreshAttempts).toBe(1);
  page.off("request", collectRequest);
  expect(await sessionIsEmpty(page)).toBe(true);
  await signIn(page);
  await expect(page.getByRole("heading", { name: "공급자", exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(providerPath);
  expect(await currentRole(page)).toBe("admin");
});
