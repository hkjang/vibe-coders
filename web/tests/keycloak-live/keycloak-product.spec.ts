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

test("KEYCLOAK-LIVE-008 자산 상세와 제외 필터가 읽기 전용 SSO 뒤에도 유지된다", async ({ page }) => {
  const assetID = "handoff-opaque-asset";
  await signIn(page, "reader", "/app/prompts/library?tab=assets&asset=" + assetID + "&asset_q=no-match");
  const link = page.getByRole("link", { name: "기존 화면에서 같은 자산 열기", exact: true });
  await expect(link).toHaveAttribute("href", "/admin#/prompt-assets?q=no-match&asset=" + assetID);
  let writes = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/admin/templates") && request.method() !== "GET")
      writes += 1;
  });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#login-backdrop.open")).toBeVisible();
  await page.getByRole("button", { name: "SSO 로그인 (Keycloak)", exact: true }).click();
  await expect(page.locator("#modal-backdrop.open")).toBeVisible();
  await expect(page.locator("#pa-edit-name")).toHaveValue("서로 다른 자산 이름");
  await expect(page.locator("#pa-edit-body")).toHaveValue("Public bridge template body");
  await expect(page.locator("#pa-edit-body")).toHaveJSProperty("readOnly", true);
  await expect(page.locator("#pa-edit-body")).toBeEnabled();
  await page.locator("#pa-edit-body").focus();
  await page.keyboard.press("Control+A");
  expect(
    await page.locator("#pa-edit-body").evaluate((node) => {
      const body = node as HTMLTextAreaElement;
      return body.value.slice(body.selectionStart, body.selectionEnd);
    }),
  ).toBe("Public bridge template body");
  await expect(
    page.locator("#legacy-asset-detail").getByRole("button", { name: "저장", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("#pa-q")).toHaveValue("no-match");
  expect(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("asset")).toBe(assetID);
  expect(await page.evaluate(() => sessionStorage.getItem("vibe.admin.auth.sso-return-to"))).toBeNull();
  await page.locator("#modal-close").click();
  await expect(page.locator("#modal-title")).toBeEmpty();
  await page.goto("/admin#/prompt-assets?asset=" + assetID);
  await expect(page.locator("#pa-edit-body")).toHaveValue("Public bridge template body");
  // Exercise the real modal stack while an asset is hidden behind another overlay.
  const nestModal = () =>
    page.evaluate(() => {
      const legacy = window as unknown as { openModal: (title: string, html: string) => void };
      legacy.openModal("공개 도움말", "<p>Public help overlay</p>");
    });
  await nestModal();
  await expect(page.locator("#pa-edit-body")).toHaveCount(0);
  await page.locator("#modal-back").click();
  await expect(page.locator("#pa-edit-body")).toHaveValue("Public bridge template body");
  await expect(page.locator("#pa-edit-body")).toHaveJSProperty("readOnly", true);
  await nestModal();
  // A route retirement must discard hidden asset snapshots as well.
  await page.evaluate(() => {
    location.hash = "#/prompt-debt?window=7d";
  });
  await expect(page.locator("#view")).toContainText("최근 7일");
  await expect(page.locator("#modal-backdrop.open")).toHaveCount(0);
  await expect(page.locator("#modal-body")).toBeEmpty();
  await page.goto("/admin#/prompt-assets?asset=" + assetID);
  await expect(page.locator("#pa-edit-body")).toHaveValue("Public bridge template body");
  await nestModal();
  // Synthetic DOM event invokes the actual logout handler/HTTP while the header is occluded.
  await page.locator("#auth-logout").dispatchEvent("click");
  await expect(page.locator("#login-backdrop.open")).toBeVisible();
  await expect(page.locator("#modal-backdrop.open")).toHaveCount(0);
  await expect(page.locator("#modal-body")).toBeEmpty();
  expect(
    await page.evaluate(() => (window as unknown as { __assetHistory: unknown[] }).__assetHistory),
  ).toEqual([]);
  await nestModal();
  await expect(page.locator("#modal-back")).toBeHidden();
  await page.evaluate(() => {
    (window as unknown as { modalBack: () => void }).modalBack();
  });
  await expect(page.locator("#modal-body")).not.toContainText("Public bridge template body");
  expect(writes).toBe(0);
});

test("KEYCLOAK-LIVE-009 검색 시각과 지문 및 부채 기간이 실제 API에 전달된다", async ({ page }) => {
  const since = "2026-11-18T03:04:05.123Z";
  const search = new URLSearchParams({ q: "public", since, limit: "37", fp_window: "90d" });
  await signIn(page, "reader", "/app/prompts/library?" + search);
  const expectedIDs = await page.evaluate(
    async (query) => {
      const response = await fetch("/admin/prompts?" + query, {
        headers: { Authorization: "Bearer " + sessionStorage.getItem("vibe.app.auth.access") },
      });
      const body: { requests: { id: string }[] } = await response.json();
      return body.requests.map((row) => row.id);
    },
    new URLSearchParams({ q: "public", since, limit: "37" }).toString(),
  );
  expect(expectedIDs.length).toBeGreaterThan(0);
  const legacyResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/admin/prompts" && url.searchParams.get("since") === since;
  });
  const link = page.getByRole("link", { name: "기존 화면에서 열기", exact: true });
  const reads: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/admin/prompts")) reads.push(url);
  });
  await link.click();
  await expect(page.locator("#login-backdrop.open")).toBeVisible();
  await page.getByRole("button", { name: "SSO 로그인 (Keycloak)", exact: true }).click();
  await expect(page.locator("#p-since")).toHaveValue(since);
  await expect(page.locator("#pf-window")).toHaveValue("90d");
  const actual: { requests: { id: string }[] } = await (await legacyResponse).json();
  expect(actual.requests.map((row) => row.id)).toEqual(expectedIDs);
  await expect
    .poll(() =>
      page
        .locator("#prompt-results tr[data-request-id]")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-request-id"))),
    )
    .toEqual(expectedIDs);

  await expect
    .poll(() =>
      reads.some(
        (url) =>
          url.pathname === "/admin/prompts" &&
          url.searchParams.get("since") === since &&
          url.searchParams.get("q") === "public" &&
          url.searchParams.get("limit") === "37",
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      reads.some(
        (url) => url.pathname === "/admin/prompts/fingerprints" && url.searchParams.get("window") === "90d",
      ),
    )
    .toBe(true);
  await page.goto("/app/prompts/library?tab=debt&debt_window=7d");
  await page.getByRole("link", { name: "기존 화면에서 열기", exact: true }).click();
  await expect
    .poll(() =>
      reads.some(
        (url) =>
          url.pathname === "/admin/prompts/debt" &&
          url.searchParams.get("window") === "7d" &&
          url.searchParams.get("limit") === "50",
      ),
    )
    .toBe(true);
  await expect(page.locator("#view")).toContainText("최근 7일");
});

async function selectedModelTarget(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch("/admin/models", {
      headers: {
        Authorization: "Bearer " + sessionStorage.getItem("vibe.app.auth.access"),
        "X-Vibe-UI": "app",
      },
    });
    const body: {
      models: { id: string; provider: string; provider_ref: string; source: string; owned_by: string }[];
    } = await response.json();
    const matches = body.models.filter((row) => row.id === "catalog +%2F?&#/공유");
    if (
      matches.length !== 2 ||
      new Set(matches.map((row) => row.provider_ref)).size !== 2 ||
      matches[0]?.provider !== matches[1]?.provider
    )
      throw Error("Synthetic colliding models missing");
    const selected = matches.find((row) => row.owned_by === "selected model owner");
    if (!selected) throw Error("Synthetic selected model missing");
    return new URLSearchParams({
      model: selected.id,
      provider_ref: selected.provider_ref,
      source: selected.source,
    }).toString();
  });
}

test("KEYCLOAK-LIVE-010 같은 이름의 공급자 모델이 실제 SSO 뒤에도 구분된다", async ({ page }) => {
  await signIn(page, "new-operator");
  const target = await selectedModelTarget(page);
  const selected = new URLSearchParams(target);
  await page.goto(
    "/app/gateway/models?" +
      new URLSearchParams({
        model: selected.get("model") ?? "",
        model_provider: selected.get("provider_ref") ?? "",
      }),
  );
  const link = page.getByRole("link", { name: "기존 화면에서 같은 모델 열기", exact: true });
  await expect(link).toHaveAttribute("href", /^\/admin#\/model-contracts\?/);
  const href = await link.getAttribute("href");
  if (!href) throw Error("Model handoff missing");
  const actualTarget = new URLSearchParams(href.split("?")[1]);
  expect(actualTarget.get("model")).toBe(selected.get("model"));
  expect(actualTarget.get("provider_ref")).toBe(selected.get("provider_ref"));
  expect(["live", "cache"]).toContain(actualTarget.get("source"));
  let writes = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/admin/") && request.method() !== "GET") writes++;
  });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#login-backdrop.open")).toBeVisible();
  await page.getByRole("button", { name: "SSO 로그인 (Keycloak)", exact: true }).click();
  const detail = page.locator("#legacy-model-detail");
  await expect(detail).toContainText("selected model owner");
  await expect(detail).toContainText(selected.get("provider_ref") ?? "missing");
  await expect(detail).not.toContainText("other model owner");
  await expect(page).toHaveURL(gateway + href);
  expect(await page.evaluate(() => sessionStorage.getItem("vibe.admin.auth.sso-return-to"))).toBeNull();
  await expect(page.locator("#mcon-run-model")).toHaveCount(0);
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(async () => {
        const axe = (
          window as unknown as {
            axe: { run: (element: Element, options: object) => Promise<{ violations: unknown[] }> };
          }
        ).axe;
        const detail = document.querySelector("#legacy-model-detail");
        if (!detail) throw Error("Detail unavailable");
        return (await axe.run(detail, { rules: { "color-contrast": { enabled: true } } })).violations.length;
      }),
    ).toBe(0);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("#auth-user").click();
  await expect(page.locator("#user-menu")).toBeVisible();
  await page.locator("#auth-logout").click();
  await expect(page.locator("#login-backdrop.open")).toBeVisible();
  await expect(detail).toBeEmpty();
  expect(writes).toBe(0);
});

test("KEYCLOAK-LIVE-011 읽기 전용 모델 상세는 다른 출처를 대신 열거나 계약을 실행하지 않는다", async ({
  page,
}) => {
  await signIn(page, "reader");
  const target = await selectedModelTarget(page);
  let writes = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/admin/") && request.method() !== "GET") writes++;
  });
  const originalSource = new URLSearchParams(target);
  originalSource.set("source", "live");
  await page.goto("/admin#/model-contracts?" + originalSource);
  await expect(page.locator("#login-backdrop.open")).toBeVisible();
  await page.getByRole("button", { name: "SSO 로그인 (Keycloak)", exact: true }).click();
  await expect(page.locator("#legacy-model-detail")).toContainText("selected model owner");
  await expect(page.locator("#legacy-model-detail")).toContainText("조회 출처가");
  await expect(
    page.locator("#legacy-model-detail dt").filter({ hasText: "공급자 상태" }).locator("+ dd"),
  ).toHaveText("ok");
  const changed = new URLSearchParams(target);
  changed.set("source", "agent_route");
  await page.goto("/admin#/model-contracts?" + changed);
  await expect(page.locator("#legacy-model-detail")).toContainText("다른 모델은 자동 선택하지 않습니다");
  await expect(page.locator("#legacy-model-detail")).not.toContainText("selected model owner");
  await page.goto("/admin#/model-contracts?" + target);
  await expect(page.locator("#legacy-model-detail")).toContainText("selected model owner");
  await page.evaluate(() => {
    location.hash = "#/prompt-debt?window=7d";
  });
  await expect(page.locator("#view")).toContainText("최근 7일");
  await expect(page.locator("#legacy-model-detail")).toHaveCount(0);
  expect(writes).toBe(0);
});
