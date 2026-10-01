import { expect, test, type Page } from "@playwright/test";

import { admin, login, required } from "../auth-live/live-fixture";

const name = "provider-browser-live";

async function storedProviderState(page: Page) {
  // A separate fresh real session avoids borrowing the UI's deliberately short
  // eight-second token at its expiry boundary. Never replace SPA credentials or
  // refresh/retry the probe to make this independent persistence check pass.
  return page.evaluate(
    async ({ providerName, account }) => {
      const loginResponse = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(account),
        signal: AbortSignal.timeout(4000),
      });
      const session: unknown = await loginResponse.json();
      if (
        !loginResponse.ok ||
        !session ||
        typeof session !== "object" ||
        !("access_token" in session) ||
        typeof session.access_token !== "string" ||
        !("refresh_token" in session) ||
        typeof session.refresh_token !== "string"
      )
        return { ok: false, exists: false, savedTimeout: false };
      let state: { ok: boolean; exists: boolean; savedTimeout: boolean };
      let closed: boolean;
      try {
        const response = await fetch("/admin/providers", {
          headers: { Authorization: `Bearer ${session.access_token}`, "X-Vibe-UI": "app" },
          cache: "no-store",
          signal: AbortSignal.timeout(4000),
        });
        const body: unknown = await response.json();
        const providers =
          body && typeof body === "object" && "providers" in body && Array.isArray(body.providers)
            ? body.providers
            : [];
        const provider: unknown = providers.find(
          (row: unknown) => row && typeof row === "object" && "name" in row && row.name === providerName,
        );
        state = {
          ok: response.ok,
          exists: Boolean(provider),
          savedTimeout:
            provider && typeof provider === "object" && "timeout_ms" in provider
              ? provider.timeout_ms === 30000
              : false,
        };
      } finally {
        const logout = await fetch("/auth/logout", {
          method: "POST",
          headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: session.refresh_token }),
          signal: AbortSignal.timeout(4000),
        });
        closed = logout.ok;
      }
      return { ...state, ok: state.ok && closed };
    },
    { providerName: name, account: admin },
  );
}

test("PROVIDER-LIVE-001 저장 전 신규·기존 키 검사와 저장 분리", async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL ?? required("APP_BASE_URL")).origin;
  let blocked = 0;
  let writes = 0;
  let probes = 0;
  await context.route("**/*", async (route) => {
    const request = route.request();
    const target = new URL(request.url());
    if (target.origin !== origin) {
      blocked += 1;
      return route.abort("blockedbyclient");
    }
    if (request.method() === "POST" && target.pathname === "/admin/providers") writes += 1;
    if (request.method() === "POST" && target.pathname === "/admin/provider-connection-test") probes += 1;
    return route.continue(); // Real Go responses only; no synthetic admin/auth API.
  });
  await login(page);
  await page.getByRole("button", { name: "공급자 추가", exact: true }).click();
  const create = page.getByRole("dialog", { name: "공급자 추가", exact: true });
  await create.getByLabel(/^이름/u).fill(name);
  await create.getByLabel(/^기본 URL/u).fill(required("VIBE_PROVIDER_CONNECTION_URL"));
  await create.getByLabel("API 키", { exact: true }).fill(required("VIBE_PROVIDER_CONNECTION_KEY"));
  await create.getByLabel("제한 시간(ms)", { exact: true }).fill("30000");
  await create.getByRole("button", { name: "연결 테스트", exact: true }).click();
  await expect(create.getByText("모델 목록 연결을 확인했습니다.", { exact: true })).toBeVisible();
  expect(probes).toBe(1);
  expect(writes).toBe(0);
  expect(await storedProviderState(page)).toEqual({ ok: true, exists: false, savedTimeout: false });
  await create.getByRole("button", { name: "저장", exact: true }).click();
  await expect(create).toBeHidden();
  expect(writes).toBe(1);
  expect(await storedProviderState(page)).toEqual({ ok: true, exists: true, savedTimeout: true });

  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name, exact: true }) });
  await row.getByRole("button", { name: "수정", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "공급자 수정", exact: true });
  await expect(edit.getByLabel("API 키", { exact: true })).toHaveValue("");
  await edit.getByLabel("제한 시간(ms)", { exact: true }).fill("7500");
  await edit.getByRole("button", { name: "연결 테스트", exact: true }).click();
  await expect(edit.getByText("모델 목록 연결을 확인했습니다.", { exact: true })).toBeVisible();
  expect(probes).toBe(2);
  expect(writes).toBe(1);
  expect(await storedProviderState(page)).toEqual({ ok: true, exists: true, savedTimeout: true });
  await expect(edit.getByRole("button", { name: "변경 내용 검토", exact: true })).toBeVisible();
  await expect(edit.getByLabel("API 키", { exact: true })).toHaveValue("");
  expect(blocked).toBe(0);
});
