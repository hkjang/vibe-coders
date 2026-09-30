import { expect, test as base, type Page } from "@playwright/test";

// Only the isolated Go harness supplies these values. Keep credentials in
// memory; no storage-state, screenshots, traces or raw response reports.
export const required = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing isolated harness input: ${key}`);
  return value;
};
export const admin = {
  email: required("VIBE_AUTH_ADMIN_EMAIL"),
  password: required("VIBE_AUTH_ADMIN_PASSWORD"),
};
export const reader = {
  email: required("VIBE_AUTH_READONLY_EMAIL"),
  password: required("VIBE_AUTH_READONLY_PASSWORD"),
};
export const providerPath = "/app/gateway/providers";
const authKeys = ["vibe.app.auth.access", "vibe.app.auth.refresh", "vibe.app.auth.legacy-admin"];

export const test = base.extend<{ isolatedNetwork: undefined }>({
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

export async function signIn(page: Page, account = admin): Promise<void> {
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
  await page.getByLabel("이메일", { exact: true }).fill(account.email);
  await page.getByLabel("비밀번호", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByLabel("사용자 메뉴")).toBeVisible();
}

export async function login(page: Page, account = admin, path = providerPath): Promise<void> {
  await page.goto(path);
  await signIn(page, account);
  await page.getByLabel("자동 새로고침 간격").selectOption("0");
}

export async function signOut(page: Page): Promise<void> {
  await page.getByLabel("사용자 메뉴").click();
  const response = page.waitForResponse(
    (value) =>
      value.request().method() === "POST" && new URL(value.url()).pathname === "/auth/keycloak/logout",
  );
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  expect((await response).ok()).toBe(true);
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
}

export async function sessionIsEmpty(page: Page): Promise<boolean> {
  return page.evaluate((keys) => keys.every((key) => !sessionStorage.getItem(key)), authKeys);
}

export async function currentRole(page: Page): Promise<string | undefined> {
  return page.evaluate(async () => {
    const response = await fetch("/auth/me", {
      headers: { Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}` },
    });
    const data: { user?: { role?: string } } = await response.json();
    return data.user?.role;
  });
}

export async function refreshStatus(page: Page, refresh: string): Promise<number> {
  return page.evaluate(async (token) => {
    const response = await fetch("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: token }),
    });
    return response.status;
  }, refresh);
}
