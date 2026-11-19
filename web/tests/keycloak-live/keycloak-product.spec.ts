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

const routingHandoffId = "SSO 규칙 +%2F?&#/exact";
test("KEYCLOAK-LIVE-012 선택한 저장 규칙이 실제 Legacy SSO 뒤에도 유지된다", async ({ page }) => {
  await signIn(page, "new-operator");
  await page.goto("/app/routing/rules?" + new URLSearchParams({ rule_id: routingHandoffId }));
  const panel = page.getByRole("dialog", { name: "라우팅 규칙 상세" });
  await expect(panel).toContainText("selected routing note");
  const link = panel.getByRole("link", { name: "기존 화면에서 같은 규칙 열기", exact: true });
  const href = "/admin#/routing?" + new URLSearchParams({ rule_id: routingHandoffId });
  await expect(link).toHaveAttribute("href", href);
  let writes = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/admin/") && request.method() !== "GET") writes++;
  });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#login-backdrop.open")).toBeVisible();
  await page.getByRole("button", { name: "SSO 로그인 (Keycloak)", exact: true }).click();
  const detail = page.locator("#legacy-routing-rule-detail");
  await expect(detail).toContainText(routingHandoffId);
  await expect(detail).toContainText("selected routing note");
  await expect(detail).not.toContainText("other routing note");
  await expect(detail).toContainText("중지됨");
  await expect(detail).toContainText("10–90");
  await expect(detail.locator("input, select, textarea, form")).toHaveCount(0);
  await expect(page).toHaveURL(gateway + href);
  expect(await page.evaluate(() => sessionStorage.getItem("vibe.admin.auth.sso-return-to"))).toBeNull();
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
        const detail = document.querySelector("#legacy-routing-rule-detail");
        if (!detail) throw Error("Routing detail unavailable");
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
test("KEYCLOAK-LIVE-013 라우팅 조회 계정의 규칙 조회와 없는 규칙·화면 전환을 구분한다", async ({ page }) => {
  await signIn(page, "routing-reader");
  expect((await currentUser(page)).role).toBe("team_admin");
  let writes = 0,
    ruleReads = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/admin/routing-rules") ruleReads++;
    if (new URL(request.url()).pathname.startsWith("/admin/") && request.method() !== "GET") writes++;
  });
  await page.goto("/admin#/routing?" + new URLSearchParams({ rule_id: routingHandoffId }));
  await expect(page.locator("#login-backdrop.open")).toBeVisible();
  await page.getByRole("button", { name: "SSO 로그인 (Keycloak)", exact: true }).click();
  const detail = page.locator("#legacy-routing-rule-detail");
  await expect(detail).toContainText("selected routing note");
  await expect(detail.getByRole("button", { name: /저장|삭제|미리보기|최적화/ })).toHaveCount(0);
  await page.goto("/admin#/routing?" + new URLSearchParams({ rule_id: "missing-routing-rule" }));
  await expect(detail).toContainText("해당 라우팅 규칙이 없습니다");
  await expect(detail).not.toContainText("selected routing note");
  const beforeInvalid = ruleReads;
  await page.goto("/admin#/routing?rule_id=%ED%A0%80");
  await expect(detail).toContainText("상세 주소가 올바르지 않습니다");
  expect(ruleReads).toBe(beforeInvalid);
  await page.goto("/admin#/routing?" + new URLSearchParams({ rule_id: routingHandoffId }));
  await expect(detail).toContainText("selected routing note");
  await page.goto("/admin#/routing/health");
  await expect(detail).toHaveCount(0);
  await expect(page.locator("#view")).toContainText("Provider Health");
  await expect(page.locator("#view")).not.toContainText("selected routing note");
  expect(writes).toBe(0);
});

test("KEYCLOAK-LIVE-014 라우팅 조회 권한이 없는 기존 역할은 규칙 내용을 읽지 못한다", async ({ page }) => {
  await signIn(page, "reader");
  expect((await currentUser(page)).role).toBe("readonly_admin");
  let writes = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/admin/") && request.method() !== "GET") writes++;
  });
  await page.goto("/admin#/routing?" + new URLSearchParams({ rule_id: routingHandoffId }));
  await expect(page.locator("#login-backdrop.open")).toBeVisible();
  const rejected = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/admin/routing-rules" && response.status() === 401,
  );
  await page.getByRole("button", { name: "SSO 로그인 (Keycloak)", exact: true }).click();
  expect((await rejected).status()).toBe(401);
  await expect(page.locator("#legacy-routing-rule-detail")).toContainText("조회 권한을 확인");
  await expect(page.locator("#login-backdrop.open")).toHaveCount(0);
  await expect(page.locator("#view")).not.toContainText("selected routing note");
  expect(writes).toBe(0);
});

const longAccessId = " 계정 +%2F?&#/ " + "가".repeat(1300) + " ";
const accessCases = [
  {
    scenario: "015",
    resource: "key",
    id: "shared-access-id",
    path: "/app/access/users?tab=keys",
    parameter: "api_key_id",
    title: "API 키 상세",
    label: "API 키",
    marker: "Shared access key",
  },
  {
    scenario: "016",
    resource: "account",
    id: "shared-access-id",
    path: "/app/access/users/accounts?",
    parameter: "account_id",
    title: "로그인 계정 상세",
    label: "계정",
    marker: "access-0@example.invalid",
  },
  {
    scenario: "017",
    resource: "team",
    id: "shared-access-id",
    path: "/app/access/users?tab=teams",
    parameter: "registered_team",
    title: "등록 팀 상세",
    label: "팀",
    marker: "Shared access",
  },
  {
    scenario: "018",
    resource: "account",
    id: longAccessId,
    path: "/app/access/users/accounts?",
    parameter: "account_id",
    title: "로그인 계정 상세",
    label: "계정",
    marker: "access-2@example.invalid",
  },
  {
    scenario: "019",
    resource: "team",
    id: longAccessId,
    path: "/app/access/users?tab=teams",
    parameter: "registered_team",
    title: "등록 팀 상세",
    label: "팀",
    marker: "Long access",
  },
];
for (const item of accessCases) {
  test("KEYCLOAK-LIVE-" + item.scenario + " 종류와 긴 ID를 실제 SSO 이후에도 보존한다", async ({ page }) => {
    await signIn(page, "new-operator");
    await page.goto(
      item.path + (item.path.endsWith("?") ? "" : "&") + new URLSearchParams({ [item.parameter]: item.id }),
    );
    const panel = page.getByRole("dialog", { name: item.title });
    await expect(panel).toContainText(item.marker);
    const href = "/admin#/users?" + new URLSearchParams({ resource: item.resource, id: item.id });
    const link = panel.getByRole("link", { name: "기존 화면에서 같은 " + item.label + " 열기", exact: true });
    await expect(link).toHaveAttribute("href", href);
    let writes = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/admin/") && request.method() !== "GET") writes++;
    });
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#login-backdrop.open")).toBeVisible();
    await page.getByRole("button", { name: "SSO 로그인 (Keycloak)", exact: true }).click();
    const detail = page.locator("#legacy-access-detail");
    await expect(detail).toContainText(item.marker);
    await expect(detail).not.toContainText("Other access");
    await expect(detail).not.toContainText("disabled-access-fixture");
    await expect(detail).not.toContainText("synthetic-access-hash");
    await expect(detail.locator("input, select, textarea, form")).toHaveCount(0);
    await expect(page).toHaveURL(gateway + href);
    expect(await page.evaluate(() => sessionStorage.getItem("vibe.admin.auth.sso-return-to"))).toBeNull();
    if (item.scenario === "015") {
      await expect(detail).toContainText("수명 상태(조회 시각 기준)");
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
            const detail = document.querySelector("#legacy-access-detail");
            if (!detail) throw Error("Access detail unavailable");
            return (await axe.run(detail, { rules: { "color-contrast": { enabled: true } } })).violations
              .length;
          }),
        ).toBe(0);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await page.locator("#auth-user").click();
    await page.locator("#auth-logout").click();
    await expect(page.locator("#login-backdrop.open")).toBeVisible();
    await expect(detail).toBeEmpty();
    expect(writes).toBe(0);
  });
}
test("KEYCLOAK-LIVE-020 실제 팀 관리자 SSO는 각 종류에서 자기 팀만 조회한다", async ({ page }) => {
  await signIn(page, "routing-reader");
  expect((await currentUser(page)).role).toBe("team_admin");
  let writes = 0,
    reads = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      ["/admin/api-keys", "/admin/users", "/admin/teams"].includes(url.pathname) &&
      url.searchParams.has("id")
    )
      reads++;
    if (url.pathname.startsWith("/admin/") && request.method() !== "GET") writes++;
  });
  await page.goto("/admin#/users?" + new URLSearchParams({ resource: "key", id: "shared-access-id" }));
  await expect(page.locator("#login-backdrop.open")).toBeVisible();
  await page.getByRole("button", { name: "SSO 로그인 (Keycloak)", exact: true }).click();
  const detail = page.locator("#legacy-access-detail");
  await expect(detail).toContainText("Shared access key");
  for (const resource of ["key", "account", "team"]) {
    await page.goto("/admin#/users?" + new URLSearchParams({ resource, id: "shared-access-id" }));
    await expect(detail).toContainText(resource === "account" ? "access-0@example.invalid" : "Shared access");
    for (const id of ["other-access-id", "missing-access-id"]) {
      await page.goto("/admin#/users?" + new URLSearchParams({ resource, id }));
      await expect(detail).toContainText("조회 가능한 항목이 없습니다");
      await expect(detail).not.toContainText("Other access");
      await expect(detail).not.toContainText("access-1@example.invalid");
    }
  }
  const beforeInvalid = reads;
  await page.goto("/admin#/users?resource=account&id=%ED%A0%80");
  await expect(detail).toContainText("상세 주소가 올바르지 않습니다");
  expect(reads).toBe(beforeInvalid);
  await page.goto("/admin#/users");
  await expect(detail).toHaveCount(0);
  await expect(page.locator("#view")).not.toContainText("access-0@example.invalid");
  expect(writes).toBe(0);
});

const schemaHandoffName = "SSO 스키마 +%2F?&#/exact";
function watchSchemaReads(page: Page) {
  let writes = 0,
    broadReads = 0,
    exactReads = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/admin/") && request.method() !== "GET") writes++;
    if (url.pathname.startsWith("/admin/text2sql")) {
      if (
        url.pathname === "/admin/text2sql" &&
        url.searchParams.get("view") === "schema" &&
        url.searchParams.has("name")
      )
        exactReads++;
      else broadReads++;
    }
  });
  return () => ({ writes, broadReads, exactReads });
}
async function openSchemaBridge(page: Page, username: string, name = schemaHandoffName) {
  await signIn(page, username);
  const reads = watchSchemaReads(page);
  await page.goto("/app/text2sql/schemas/detail?" + new URLSearchParams({ schema_name: name }));
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  const href = "/admin#/text2sql?" + new URLSearchParams({ schema_name: name });
  const link = page.getByRole("link", { name: "기존 화면에서 열기", exact: true });
  await expect(link).toHaveAttribute("href", href);
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#login-backdrop.open")).toBeVisible();
  await page.getByRole("button", { name: "SSO 로그인 (Keycloak)", exact: true }).click();
  const detail = page.locator("#legacy-text2sql-schema-detail");
  await expect(detail).toContainText(name);
  await expect(page).toHaveURL(gateway + href);
  expect(await page.evaluate(() => sessionStorage.getItem("vibe.admin.auth.sso-return-to"))).toBeNull();
  return { detail, reads };
}
test("KEYCLOAK-LIVE-021 선택한 스키마의 원문과 테이블을 실제 SSO 후 읽기 전용으로 탐색한다", async ({
  page,
}) => {
  const { detail, reads } = await openSchemaBridge(page, "new-operator");
  await expect(detail).toContainText("중지됨");
  await expect(detail).not.toContainText("schema private approved text");
  const toggle = detail.getByRole("button", { name: "설명 보기", exact: true });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(detail.getByLabel("스키마 설명 본문")).toHaveText("schema private approved text");
  await expect(detail.getByRole("list", { name: "허용 테이블" }).locator("li")).toHaveCount(50);
  await detail.getByRole("button", { name: "다음 테이블", exact: true }).click();
  await expect(detail.getByRole("list", { name: "허용 테이블" }).locator("li")).toHaveCount(1);
  await expect(detail).toContainText("schema_private_table_050");
  await expect(detail.locator("input,select,textarea,form")).toHaveCount(0);
  await expect(detail.getByRole("button", { name: /저장|삭제|실행|연결 테스트/ })).toHaveCount(0);
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
        const detail = document.querySelector("#legacy-text2sql-schema-detail");
        if (!detail) throw Error("Schema detail unavailable");
        return (await axe.run(detail, { rules: { "color-contrast": { enabled: true } } })).violations.length;
      }),
    ).toBe(0);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("#auth-user").click();
  await page.locator("#auth-logout").click();
  await expect(page.locator("#login-backdrop.open")).toBeVisible();
  await expect(detail).toBeEmpty();
  expect(reads().writes).toBe(0);
  expect(reads().broadReads).toBe(0);
  expect(reads().exactReads).toBeGreaterThanOrEqual(2);
});
test("KEYCLOAK-LIVE-022 원문 권한이 없는 실제 SSO 역할은 스키마 등록 정보만 읽는다", async ({ page }) => {
  const { detail, reads } = await openSchemaBridge(page, "reader");
  await expect(detail).toContainText("스키마 설명과 허용 테이블은 비공개");
  await expect(detail).not.toContainText("schema private approved text");
  await expect(detail).not.toContainText("schema_private_table");
  await expect(detail.getByRole("button", { name: "설명 보기", exact: true })).toHaveCount(0);
  await expect(detail.getByRole("list", { name: "허용 테이블" })).toHaveCount(0);
  await expect(detail).not.toContainText("별도 테이블 제한이 없습니다");
  expect(reads().writes).toBe(0);
  expect(reads().broadReads).toBe(0);
});
test("KEYCLOAK-LIVE-023 실제 팀 범위와 공용 스키마만 유지하며 없는 항목은 대체하지 않는다", async ({
  page,
}) => {
  const { detail, reads } = await openSchemaBridge(page, "routing-reader");
  await expect(detail).toContainText("스키마 설명과 허용 테이블은 비공개");
  for (const name of ["public-schema", "schema-shared-by-name"]) {
    await page.goto("/admin#/text2sql?" + new URLSearchParams({ schema_name: name }));
    await expect(detail).toContainText(name);
    await expect(detail).toContainText("스키마 설명과 허용 테이블은 비공개");
  }
  for (const name of ["foreign-schema", "missing-schema"]) {
    const unavailable = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/admin/text2sql" &&
        url.searchParams.get("name") === name &&
        response.status() === 404
      );
    });
    await page.goto("/admin#/text2sql?" + new URLSearchParams({ schema_name: name }));
    expect((await unavailable).status()).toBe(404);
    await expect(detail).toContainText("선택한 스키마를 불러오지 못했습니다");
    await expect(detail).not.toContainText("schema private approved text");
    await expect(detail).not.toContainText("schema_private_table");
  }
  const before = reads().exactReads;
  await page.goto("/admin#/text2sql?schema_name=%ED%A0%80");
  await expect(detail).toContainText("스키마 상세 주소가 올바르지 않습니다");
  expect(reads().exactReads).toBe(before);
  await page.goto("/admin#/users");
  await expect(detail).toHaveCount(0);
  expect(reads().writes).toBe(0);
  expect(reads().broadReads).toBe(0);
});
test("KEYCLOAK-LIVE-024 최대 Unicode 이름과 긴 원문은 SSO와 페이지 경계에서 손실되지 않는다", async ({
  page,
}) => {
  const { detail, reads } = await openSchemaBridge(page, "new-operator", "😀".repeat(512));
  await detail.getByRole("button", { name: "설명 보기", exact: true }).click();
  const context = detail.getByLabel("스키마 설명 본문");
  await expect(context).toHaveText("가".repeat(16383));
  await detail.getByRole("button", { name: "다음 설명", exact: true }).click();
  await expect(context).toHaveText("😀schema-final-tail");
  await expect(context).toBeFocused();
  await detail.getByRole("button", { name: "이전 설명", exact: true }).click();
  await expect(context).toHaveText("가".repeat(16383));
  const before = reads().exactReads;
  await detail.getByRole("button", { name: "설명 접기", exact: true }).click();
  await expect(context).toHaveCount(0);
  expect(reads().exactReads).toBe(before);
  expect(reads().writes).toBe(0);
  expect(reads().broadReads).toBe(0);
  await detail.getByRole("link", { name: "Text2SQL 전체 화면 열기", exact: true }).click();
  await expect(page.locator("#t2s-schema-form")).toBeVisible();
  await expect(detail).toHaveCount(0);
  expect(reads().writes).toBe(0);
});

// The private fixture changes stored grants and signs an expired copy of the
// current token. The actual background refresh performs HTTP 401 -> /auth/refresh
// while the previous private view is still open.
type LegacyGrantClient = {
  saveAuth: (pair: { access_token: string; refresh_token: string }) => void;
  refreshLegacyAppEntry: () => Promise<unknown>;
  api: (path: string) => Promise<unknown>;
};
async function expireLegacyGrant(page: Page, operation: string) {
  const control = process.env.VIBE_GRANT_CONTROL;
  if (!control) throw Error("Private grant control missing");
  const access = await page.evaluate(() => sessionStorage.getItem("authAccess") ?? "");
  const result = await page.request.post("/__fixture/grants", {
    headers: { "X-Fixture-Control": control, Authorization: "Bearer " + access },
    data: { operation },
  });
  expect(result.status()).toBe(200);
  const body = (await result.json()) as { expired_access: string };
  expect(typeof body.expired_access).toBe("string");
  await page.evaluate((expired) => {
    const client = window as unknown as LegacyGrantClient;
    client.saveAuth({ access_token: expired, refresh_token: sessionStorage.getItem("authRefresh") ?? "" });
    setTimeout(() => void client.refreshLegacyAppEntry(), 0);
  }, body.expired_access);
}
async function restoreGrantFixture(page: Page) {
  const result = await page.request.post("/__fixture/grants", {
    headers: { "X-Fixture-Control": process.env.VIBE_GRANT_CONTROL ?? "" },
    data: { operation: "restore" },
  });
  expect(result.status()).toBe(204);
}

test("KEYCLOAK-LIVE-025 역할 강등 갱신은 열린 비공개 원문과 이전 응답을 폐기한다", async ({ page }) => {
  const { detail, reads } = await openSchemaBridge(page, "new-operator");
  await detail.getByRole("button", { name: "설명 보기", exact: true }).click();
  await expect(detail.getByLabel("스키마 설명 본문")).toHaveText("schema private approved text");
  const originalURL = page.url();
  let oldCaptured = false,
    held = false,
    documents = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  await page.route("**/admin/text2sql?*", async (route) => {
    if (held) {
      await route.continue();
      return;
    }
    held = true;
    const response = await route.fetch();
    oldCaptured = true;
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) documents++;
  });
  await page.evaluate((name) => {
    void (window as unknown as LegacyGrantClient)
      .api("/admin/text2sql?" + new URLSearchParams({ view: "schema", name }))
      .then(
        () => sessionStorage.setItem("grant-test-old-returned", "1"),
        () => {},
      );
  }, schemaHandoffName);
  await expect.poll(() => oldCaptured).toBe(true);
  try {
    await expireLegacyGrant(page, "role");
    await expect(detail).toContainText("스키마 설명과 허용 테이블은 비공개");
    await expect(page.locator("#auth-user")).toContainText("readonly_admin");
    release();
    await expect(detail).not.toContainText("schema private approved text");
    expect(await page.evaluate(() => sessionStorage.getItem("grant-test-old-returned"))).toBeNull();
    expect(page.url()).toBe(originalURL);
    expect(documents).toBe(1);
    expect(reads().writes).toBe(0);
  } finally {
    release();
    await restoreGrantFixture(page);
  }
});

test("KEYCLOAK-LIVE-026 팀 변경 갱신은 이전 팀 상세를 같은 주소에서 다시 검증한다", async ({ page }) => {
  const { detail, reads } = await openSchemaBridge(page, "routing-reader");
  await expect(detail).toContainText(schemaHandoffName);
  const originalURL = page.url();
  try {
    await expireLegacyGrant(page, "team");
    await expect(detail).toContainText("선택한 스키마를 불러오지 못했습니다");
    await expect(detail).not.toContainText(schemaHandoffName);
    expect(page.url()).toBe(originalURL);
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("authUser") ?? "{}").team_id)).toBe(
      "other-access-id",
    );
    expect(reads().writes).toBe(0);
  } finally {
    await restoreGrantFixture(page);
  }
});

test("KEYCLOAK-LIVE-027 동일 역할의 권한 축소도 이전 화면과 메뉴를 폐기한다", async ({ page }) => {
  const { detail, reads } = await openSchemaBridge(page, "new-operator");
  await detail.getByRole("button", { name: "설명 보기", exact: true }).click();
  await expect(detail).toContainText("schema private approved text");
  try {
    await expireLegacyGrant(page, "scopes");
    await expect(page.getByRole("heading", { name: "접근 권한이 필요합니다", exact: true })).toBeVisible();
    await expect(page.locator("#view")).not.toContainText("schema private approved text");
    await expect(page.locator("#tabs a[data-tab=text2sql]")).toBeHidden();
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("authUser") ?? "{}").role)).toBe(
      "admin",
    );
    expect(reads().writes).toBe(0);
  } finally {
    await restoreGrantFixture(page);
  }
});

test("KEYCLOAK-LIVE-028 동일 권한 갱신은 열린 원문과 현재 문서를 유지한다", async ({ page }) => {
  const { detail, reads } = await openSchemaBridge(page, "new-operator");
  await detail.getByRole("button", { name: "설명 보기", exact: true }).click();
  await expect(detail).toContainText("schema private approved text");
  let documents = 0,
    refreshes = 0,
    navigation = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) documents++;
  });
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path === "/auth/refresh") refreshes++;
    if (path === "/me/navigation" && response.status() === 200) navigation++;
  });
  try {
    await expireLegacyGrant(page, "same");
    await expect.poll(() => navigation).toBe(1);
    expect(refreshes).toBe(1);
    expect(documents).toBe(0);
    await expect(detail.getByLabel("스키마 설명 본문")).toHaveText("schema private approved text");
    expect(reads().writes).toBe(0);
  } finally {
    await restoreGrantFixture(page);
  }
});

test("KEYCLOAK-LIVE-029 이전 서버 형식의 갱신 검증 실패는 자격 증명을 보존하고 복구한다", async ({
  page,
}) => {
  const { detail, reads } = await openSchemaBridge(page, "new-operator");
  await detail.getByRole("button", { name: "설명 보기", exact: true }).click();
  await expect(detail).toContainText("schema private approved text");
  // Fault injection removes optional metadata and makes identity reads fail.
  // The rotated credentials are still issued by the actual gateway.
  await page.route("**/auth/refresh", async (route) => {
    const result = await route.fetch();
    const body: Record<string, unknown> = await result.json();
    delete body.user;
    await route.fulfill({ response: result, json: body });
  });
  await page.route("**/auth/me", (route) => route.fulfill({ status: 503, json: {} }));
  let refreshes = 0,
    documents = 0;
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/auth/refresh") refreshes++;
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) documents++;
  });
  const before = await page.evaluate(() => sessionStorage.getItem("authRefresh"));
  try {
    await expireLegacyGrant(page, "same");
    await expect(
      page.getByRole("heading", { name: "로그인 권한을 확인하지 못했습니다.", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#view")).not.toContainText("schema private approved text");
    expect(
      await page.evaluate(
        (previous) =>
          Boolean(sessionStorage.getItem("authRefresh")) &&
          sessionStorage.getItem("authRefresh") !== previous,
        before,
      ),
    ).toBe(true);
    expect(refreshes).toBe(1);
    expect(documents).toBe(1);
    await page.unroute("**/auth/me");
    await page.getByRole("button", { name: "권한 다시 확인", exact: true }).click();
    await expect(detail).toContainText(schemaHandoffName);
    await expect(detail.getByRole("button", { name: "설명 보기", exact: true })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("vibe.admin.auth.grant-review"))).toBeNull();
    expect(refreshes).toBe(1);
    expect(reads().writes).toBe(0);
  } finally {
    await restoreGrantFixture(page);
  }
});

const workAppHandoffID = " 업무 앱 +%2F?&#/ ";
async function openWorkAppBridge(page: Page, username: string, id = workAppHandoffID) {
  await signIn(page, username);
  let writes = 0,
    broadReads = 0,
    exactReads = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      (url.pathname.startsWith("/admin/") || url.pathname.startsWith("/v1/apps/")) &&
      request.method() !== "GET"
    )
      writes++;
    if (url.pathname === "/admin/apps") {
      if (url.searchParams.get("view") === "detail") exactReads++;
      else if (url.searchParams.get("view") !== "page") broadReads++;
    }
  });
  await page.goto("/app/agents/apps?" + new URLSearchParams({ app: id }));
  const sheet = page.getByRole("dialog", { name: /같은 업무 앱 제목/u });
  await expect(sheet).toBeVisible();
  const href = "/admin#/apps?" + new URLSearchParams({ app_id: id });
  const link = sheet.getByRole("link", { name: "기존 화면에서 열기", exact: true });
  await expect(link).toHaveAttribute("href", href);
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#login-backdrop.open")).toBeVisible();
  await page.getByRole("button", { name: "SSO 로그인 (Keycloak)", exact: true }).click();
  const detail = page.locator("#legacy-work-app-detail");
  await expect(detail).toContainText("work-app-owner");
  await expect(page).toHaveURL(gateway + href);
  expect(await page.evaluate(() => sessionStorage.getItem("vibe.admin.auth.sso-return-to"))).toBeNull();
  return { detail, reads: () => ({ writes, broadReads, exactReads }) };
}
test("KEYCLOAK-LIVE-030 같은 이름의 앱 중 선택한 앱만 실제 SSO로 열고 참조를 탐색한다", async ({ page }) => {
  const { detail, reads } = await openWorkAppBridge(page, "new-operator");
  await expect(detail).toContainText("선택한 업무 앱 설명");
  await expect(detail).not.toContainText("다른 앱의 설명");
  await expect(detail).toContainText("지원 중단");
  await expect(detail.getByRole("list", { name: "업무 앱 구성 요소" }).locator("li")).toHaveCount(50);
  await detail.getByRole("button", { name: "다음 구성 요소", exact: true }).click();
  await expect(detail.getByRole("list", { name: "업무 앱 구성 요소" }).locator("li")).toHaveCount(1);
  await expect(detail).toContainText("work-app-component-050");
  await expect(detail.locator("input,select,textarea,form")).toHaveCount(0);
  await expect(detail.getByRole("button", { name: /발행|삭제|검증|실행|권한 관리/ })).toHaveCount(0);
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
        const detail = document.querySelector("#legacy-work-app-detail");
        if (!detail) throw Error("Work app detail missing");
        return (await axe.run(detail, { rules: { "color-contrast": { enabled: true } } })).violations.length;
      }),
    ).toBe(0);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("#auth-user").click();
  await page.locator("#auth-logout").click();
  await expect(page.locator("#login-backdrop.open")).toBeVisible();
  await expect(detail).toBeEmpty();
  expect(reads().writes).toBe(0);
  expect(reads().broadReads).toBe(0);
  expect(reads().exactReads).toBeGreaterThanOrEqual(2);
});
test("KEYCLOAK-LIVE-031 읽기 전용 관리자는 기존 관리자 조회 규칙으로 업무 앱을 읽는다", async ({ page }) => {
  const { detail, reads } = await openWorkAppBridge(page, "reader");
  await expect(detail).toContainText("지원 중단");
  await expect(detail).toContainText("other-access-id");
  await expect(detail).toContainText("developer");
  await expect(detail).toContainText("선택한 업무 앱 설명");
  expect(reads().writes).toBe(0);
  expect(reads().broadReads).toBe(0);
});
test("KEYCLOAK-LIVE-032 최대 UTF8 앱 ID와 긴 설명을 보존하며 오류가 다른 앱을 열지 않는다", async ({
  page,
}) => {
  const { detail, reads } = await openWorkAppBridge(page, "new-operator", "😀".repeat(1024));
  const description = detail.getByLabel("업무 앱 설명", { exact: true });
  await expect(description).toHaveText("가".repeat(16383));
  await detail.getByRole("button", { name: "다음 설명", exact: true }).click();
  await expect(description).toHaveText("😀work-app-final-tail");
  await expect(description).toBeFocused();
  await page.goto("/admin#/apps?app_id=missing-app");
  await expect(detail).toContainText("선택한 업무 앱을 불러오지 못했습니다");
  await expect(detail).not.toContainText("work-app-owner");
  const before = reads().exactReads;
  await page.goto("/admin#/apps?app_id=%ED%A0%80");
  await expect(detail).toContainText("업무 앱 상세 주소가 올바르지 않습니다");
  expect(reads().exactReads).toBe(before);
  // An old list response must not replace the current exact detail.
  let captured = false,
    release: () => void = () => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let completed = false;
  await page.route("**/admin/apps", async (route) => {
    if (captured) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    captured = true;
    await gate;
    await route.fulfill({ response }).catch(() => {});
    completed = true;
  });
  await detail.getByRole("link", { name: "업무 앱 전체 화면 열기", exact: true }).click();
  await expect.poll(() => captured).toBe(true);
  await page.goto("/admin#/apps?" + new URLSearchParams({ app_id: workAppHandoffID }));
  await expect(detail).toContainText("선택한 업무 앱 설명");
  release();
  await expect.poll(() => completed).toBe(true);
  await page.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  await expect(detail).toContainText("선택한 업무 앱 설명");
  await expect(page.locator("#app-title")).toHaveCount(0);
  await detail.getByRole("link", { name: "업무 앱 전체 화면 열기", exact: true }).click();
  await expect(page.locator("#app-title")).toBeAttached();
  await expect(detail).toHaveCount(0);
  await page.goto("/admin#/apps?view=all");
  await expect(page.locator("#app-title")).toBeAttached();
  await expect(detail).toHaveCount(0);
  expect(reads().writes).toBe(0);
});
test("KEYCLOAK-LIVE-033 팀 관리자의 기존 전체 앱 조회 정책을 변경하지 않는다", async ({ page }) => {
  const { detail, reads } = await openWorkAppBridge(page, "routing-reader");
  await expect(detail).toContainText("other-access-id");
  await expect(detail).toContainText("선택한 업무 앱 설명");
  await expect(page.locator("#auth-user")).toContainText("team_admin");
  expect(reads().writes).toBe(0);
  expect(reads().broadReads).toBe(0);
});

const workflowHandoffID = " 워크플로 +%2F?&#/ ";
async function openWorkflowBridge(page: Page, username: string, id = workflowHandoffID) {
  await signIn(page, username);
  let writes = 0,
    broadReads = 0,
    exactReads = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      (url.pathname.startsWith("/admin/") || url.pathname.startsWith("/v1/workflows/")) &&
      request.method() !== "GET"
    )
      writes++;
    if (url.pathname === "/admin/workflows") {
      if (url.searchParams.get("view") === "detail") exactReads++;
      else if (url.searchParams.get("view") !== "page") broadReads++;
    }
  });
  await page.goto("/app/agents/workflows?" + new URLSearchParams({ workflow: id }));
  const sheet = page.getByRole("dialog", { name: /같은 워크플로 제목/u });
  await expect(sheet).toBeVisible();
  const href = "/admin#/workflows?" + new URLSearchParams({ workflow_id: id });
  const link = sheet.getByRole("link", { name: "기존 화면에서 열기", exact: true });
  await expect(link).toHaveAttribute("href", href);
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#login-backdrop.open")).toBeVisible();
  await page.getByRole("button", { name: "SSO 로그인 (Keycloak)", exact: true }).click();
  const detail = page.locator("#legacy-workflow-detail");
  await expect(detail).toContainText("workflow-owner");
  await expect(page).toHaveURL(gateway + href);
  expect(await page.evaluate(() => sessionStorage.getItem("vibe.admin.auth.sso-return-to"))).toBeNull();
  return { detail, reads: () => ({ writes, broadReads, exactReads }) };
}
test("KEYCLOAK-LIVE-034 같은 이름의 워크플로 중 선택한 분기 정의를 실제 SSO로 연다", async ({ page }) => {
  const { detail, reads } = await openWorkflowBridge(page, "new-operator");
  await expect(detail).toContainText("선택한 워크플로 설명");
  await expect(detail).not.toContainText("다른 워크플로 설명");
  await expect(detail).toContainText("중지");
  const definition = JSON.parse(await detail.getByLabel("단계와 흐름 정의", { exact: true }).innerText()) as {
    steps: { condition?: { operator: string; value: string } }[];
    flow: { entry: string; edges: { from: string; to: string; when: string }[] };
  };
  expect(definition.steps[0]?.condition).toEqual({ operator: "equals", value: "exact-input" });
  expect(definition.flow.entry).toBe("choose");
  expect(definition.flow.edges).toEqual([
    { from: "choose", to: "finish", when: "true" },
    { from: "choose", to: "$end", when: "false" },
    { from: "finish", to: "$end", when: "next" },
  ]);
  await expect(detail.locator("input,select,textarea,form")).toHaveCount(0);
  await expect(detail.getByRole("button", { name: /발행|게시|삭제|검증|실행|드라이런/ })).toHaveCount(0);
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
        const detail = document.querySelector("#legacy-workflow-detail");
        if (!detail) throw Error("Workflow detail missing");
        return (await axe.run(detail, { rules: { "color-contrast": { enabled: true } } })).violations.length;
      }),
    ).toBe(0);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("#auth-user").click();
  await page.locator("#auth-logout").click();
  await expect(page.locator("#login-backdrop.open")).toBeVisible();
  await expect(detail).toBeEmpty();
  expect(reads().writes).toBe(0);
  expect(reads().broadReads).toBe(0);
  expect(reads().exactReads).toBeGreaterThanOrEqual(2);
});
test("KEYCLOAK-LIVE-035 읽기 전용 관리자는 기존 관리자 조회 규칙으로 워크플로를 읽는다", async ({ page }) => {
  const { detail, reads } = await openWorkflowBridge(page, "reader");
  await expect(detail).toContainText("중지");
  await expect(detail).toContainText("other-access-id");
  await expect(detail).toContainText("선택한 워크플로 설명");
  expect(reads().writes).toBe(0);
  expect(reads().broadReads).toBe(0);
});
test("KEYCLOAK-LIVE-036 최대 UTF8 워크플로 ID와 모든 단계를 보존하고 오래된 목록 응답을 폐기한다", async ({
  page,
}) => {
  const { detail, reads } = await openWorkflowBridge(page, "new-operator", "😀".repeat(1024));
  const description = detail.getByLabel("워크플로 설명", { exact: true });
  await expect(description).toHaveText("가".repeat(16383));
  await detail.getByRole("button", { name: "다음 워크플로 설명", exact: true }).click();
  await expect(description).toHaveText("😀workflow-final-tail");
  await expect(description).toBeFocused();
  let savedDefinition = "";
  for (let i = 0; i < 20; i++) {
    savedDefinition += await detail.getByLabel("단계와 흐름 정의", { exact: true }).innerText();
    const next = detail.getByRole("button", { name: "다음 단계와 흐름 정의", exact: true });
    if ((await next.count()) === 0 || (await next.isDisabled())) break;
    await next.click();
  }
  const steps = (
    JSON.parse(savedDefinition) as {
      steps: {
        name: string;
        ref: string;
        timeout_ms: number;
        max_cost_krw: number;
        max_tokens: number;
        allowed_tools: string[];
        allowed_tables: string[];
        note: string;
      }[];
    }
  ).steps;
  expect(steps).toHaveLength(51);
  expect(steps[50]).toMatchObject({
    name: "저장된 단계 050",
    ref: "workflow-ref-050",
    timeout_ms: 1200,
    max_cost_krw: 3.5,
    max_tokens: 100,
    allowed_tools: ["saved-tool"],
    allowed_tables: ["saved-table"],
    note: "가".repeat(100) + "😀note-tail",
  });
  await page.goto("/admin#/workflows?workflow_id=empty-workflow");
  await expect(detail).toContainText("등록된 단계 순서");
  expect(JSON.parse(await detail.getByLabel("단계와 흐름 정의", { exact: true }).innerText())).toEqual({
    steps: [],
  });

  await page.goto("/admin#/workflows?workflow_id=missing-workflow");
  await expect(detail).toContainText("선택한 워크플로를 불러오지 못했습니다");
  await expect(detail).not.toContainText("workflow-owner");
  const before = reads().exactReads;
  await page.goto("/admin#/workflows?workflow_id=%ED%A0%80");
  await expect(detail).toContainText("워크플로 상세 주소가 올바르지 않습니다");
  expect(reads().exactReads).toBe(before);
  // An old list response must not replace the current exact detail.
  let captured = false,
    release: () => void = () => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let completed = false;
  await page.route("**/admin/workflows", async (route) => {
    if (captured) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    captured = true;
    await gate;
    await route.fulfill({ response }).catch(() => {});
    completed = true;
  });
  await detail.getByRole("link", { name: "워크플로 전체 화면 열기", exact: true }).click();
  await expect.poll(() => captured).toBe(true);
  await page.goto("/admin#/workflows?" + new URLSearchParams({ workflow_id: workflowHandoffID }));
  await expect(detail).toContainText("선택한 워크플로 설명");
  release();
  await expect.poll(() => completed).toBe(true);
  await page.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  await expect(detail).toContainText("선택한 워크플로 설명");
  await expect(page.locator("#wf-form")).toHaveCount(0);
  await detail.getByRole("link", { name: "워크플로 전체 화면 열기", exact: true }).click();
  await expect(page.locator("#wf-form")).toBeAttached();
  await expect(detail).toHaveCount(0);
  await page.goto("/admin#/workflows?view=all");
  await expect(page.locator("#wf-form")).toBeAttached();
  await expect(detail).toHaveCount(0);
  expect(reads().writes).toBe(0);
});
test("KEYCLOAK-LIVE-037 팀 관리자의 기존 전체 워크플로 조회 정책을 변경하지 않는다", async ({ page }) => {
  const { detail, reads } = await openWorkflowBridge(page, "routing-reader");
  await expect(detail).toContainText("other-access-id");
  await expect(detail).toContainText("선택한 워크플로 설명");
  await expect(page.locator("#auth-user")).toContainText("team_admin");
  expect(reads().writes).toBe(0);
  expect(reads().broadReads).toBe(0);
});

const skillHandoffName = "/스킬 +%2F?&#/";
async function nativeSkill(page: Page, name: string) {
  return page.evaluate(async (target) => {
    const response = await fetch("/admin/skills", {
      headers: { Authorization: "Bearer " + sessionStorage.getItem("vibe.app.auth.access") },
    });
    if (!response.ok) throw new Error("Skill catalog unavailable");
    const data: {
      skills: {
        name: string;
        skill_ref: string;
        description: string;
        metadata: string;
        version: string;
        owner: string;
      }[];
    } = await response.json();
    const selected = data.skills.find((skill) => skill.name === target);
    if (!selected) throw new Error("Fixture skill unavailable");
    return selected;
  }, name);
}
async function openSkillBridge(page: Page, username: string, name = skillHandoffName, fromRow = false) {
  await signIn(page, username);
  let writes = 0,
    legacyBroadReads = 0,
    exactReads = 0,
    legacyOtherReads = 0,
    legacy = false;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      (url.pathname.startsWith("/admin/") || url.pathname.startsWith("/v1/skills")) &&
      request.method() !== "GET"
    )
      writes++;
    if (url.pathname === "/admin/skills") {
      if (url.searchParams.get("view") === "detail") exactReads++;
      else if (legacy) legacyBroadReads++;
    } else if (legacy && url.pathname.startsWith("/admin/skills/")) legacyOtherReads++;
  });
  const selected = await nativeSkill(page, name);
  expect(selected.skill_ref).toMatch(/^skl_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
  if (fromRow) {
    await page.goto("/app/agents/skills");
    const row = page.getByRole("button", { name: name + " 상세 열기", exact: true });
    await row.focus();
    await page.keyboard.press("Enter");
  } else {
    await page.goto("/app/agents/skills?" + new URLSearchParams({ skill_ref: selected.skill_ref }));
  }
  expect(new URL(page.url()).searchParams.get("skill_ref")).toBe(selected.skill_ref);
  expect(new URL(page.url()).searchParams.has("skill")).toBe(false);
  const sheet = page.getByRole("dialog", { name, exact: true });
  await expect(sheet).toBeVisible();
  const href = "/admin#/skills?" + new URLSearchParams({ skill_ref: selected.skill_ref });
  const link = sheet.getByRole("link", { name: "기존 화면에서 열기", exact: true });
  await expect(link).toHaveAttribute("href", href);
  await link.focus();
  legacy = true;
  await page.keyboard.press("Enter");
  await expect(page.locator("#login-backdrop.open")).toBeVisible();
  await page.getByRole("button", { name: "SSO 로그인 (Keycloak)", exact: true }).click();
  const detail = page.locator("#legacy-skill-detail");
  await expect(detail).toContainText("skill-owner");
  await expect(page).toHaveURL(gateway + href);
  expect(await page.evaluate(() => sessionStorage.getItem("vibe.admin.auth.sso-return-to"))).toBeNull();
  return {
    detail,
    reference: selected.skill_ref,
    reads: () => ({ writes, legacyBroadReads, exactReads, legacyOtherReads }),
  };
}
test("KEYCLOAK-LIVE-038 슬래시가 있는 스킬 이름을 실제 SSO로 유지하고 모든 저장 정책을 읽는다", async ({
  page,
}) => {
  const { detail, reads } = await openSkillBridge(page, "new-operator");
  for (const value of [
    "선택한 스킬 지침",
    "2.3.4",
    "지원 중단",
    "높음",
    "selected-model-*",
    "selected-tool",
    "other-access-id",
    "skill-editor",
  ])
    await expect(detail).toContainText(value);
  await expect(detail).not.toContainText("다른 스킬 지침");
  await expect(detail.getByLabel("스킬 메타데이터", { exact: true })).toHaveText('{"selected":"metadata"}');
  await expect(detail.locator("input,select,textarea,form")).toHaveCount(0);
  await expect(detail.getByRole("button", { name: /승격|저장|삭제|스캔|평가|실행/ })).toHaveCount(0);
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
        const detail = document.querySelector("#legacy-skill-detail");
        if (!detail) throw Error("Skill detail missing");
        return (await axe.run(detail, { rules: { "color-contrast": { enabled: true } } })).violations.length;
      }),
    ).toBe(0);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("#auth-user").click();
  await page.locator("#auth-logout").click();
  await expect(page.locator("#login-backdrop.open")).toBeVisible();
  await expect(detail).toBeEmpty();
  expect(reads()).toMatchObject({ writes: 0, legacyBroadReads: 0, legacyOtherReads: 0 });
  expect(reads().exactReads).toBeGreaterThanOrEqual(1);
});
test("KEYCLOAK-LIVE-039 읽기 전용 관리자의 기존 스킬 지침 조회 범위를 유지한다", async ({ page }) => {
  const { detail, reads } = await openSkillBridge(page, "reader");
  await expect(detail).toContainText("선택한 스킬 지침");
  await expect(detail).toContainText("other-access-id");
  expect(reads()).toMatchObject({ writes: 0, legacyBroadReads: 0, legacyOtherReads: 0 });
});
test("KEYCLOAK-LIVE-040 최대 UTF8 스킬 이름과 긴 지침을 보존하고 목록 응답과 오류를 격리한다", async ({
  page,
}) => {
  const { detail, reads } = await openSkillBridge(page, "new-operator", "😀".repeat(1024));
  async function fullText(label: string) {
    let text = "";
    for (let i = 0; i < 20; i++) {
      text += await detail.getByLabel(label, { exact: true }).innerText();
      const next = detail.getByRole("button", { name: "다음 " + label, exact: true });
      if ((await next.count()) === 0 || (await next.isDisabled())) break;
      await next.click();
      await expect(detail.getByLabel(label, { exact: true })).toBeFocused();
    }
    return text;
  }
  const expected = "가".repeat(16383) + "😀skill-final-tail";
  expect(await fullText("스킬 설명")).toBe(expected);
  expect(await fullText("스킬 지침")).toBe(expected);
  expect((JSON.parse(await fullText("스킬 메타데이터")) as { text: string }).text).toBe(expected);
  await page.goto("/admin#/skills?skill_name=missing-skill");
  await expect(detail).toContainText("선택한 스킬을 불러오지 못했습니다");
  await expect(detail).not.toContainText("skill-owner");
  const before = reads().exactReads;
  await page.goto("/admin#/skills?skill_name=%ED%A0%80");
  await expect(detail).toContainText("스킬 상세 주소가 올바르지 않습니다");
  expect(reads().exactReads).toBe(before);
  // Hold an actual overview response at each asynchronous boundary.
  for (const path of ["/admin/skills", "/admin/skills/stats"]) {
    let captured = false,
      completed = false,
      release: () => void = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    await page.route("**" + path, async (route) => {
      if (captured) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      captured = true;
      await gate;
      await route.fulfill({ response }).catch(() => {});
      completed = true;
    });
    await detail.getByRole("link", { name: "스킬 전체 화면 열기", exact: true }).click();
    await expect.poll(() => captured).toBe(true);
    await page.goto("/admin#/skills?" + new URLSearchParams({ skill_name: skillHandoffName }));
    await expect(detail).toContainText("선택한 스킬 지침");
    release();
    await expect.poll(() => completed).toBe(true);
    await page.evaluate(
      () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
    );
    await expect(detail).toContainText("선택한 스킬 지침");
    await page.unroute("**" + path);
  }
  await page.goto("/admin#/skills?view=all");
  await expect(page.locator("#skill-status-filter")).toBeAttached();
  await expect(detail).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const cache = (window as unknown as { _skillsByName: Record<string, { instructions: string }> })
        ._skillsByName;
      return (
        Object.getPrototypeOf(cache) === null &&
        Object.hasOwn(cache, "__proto__") &&
        cache["__proto__"]?.instructions === "prototype-name skill instructions"
      );
    }),
  ).toBe(true);
  await page.goto("/admin#/skills?skill_name=__proto__");
  await expect(detail).toContainText("prototype-name skill instructions");
  expect(reads().writes).toBe(0);
});
test("KEYCLOAK-LIVE-041 팀 관리자의 기존 전체 스킬 카탈로그 조회 정책을 유지한다", async ({ page }) => {
  const { detail, reads } = await openSkillBridge(page, "routing-reader");
  await expect(detail).toContainText("선택한 스킬 지침");
  await expect(detail).toContainText("other-access-id");
  await expect(page.locator("#auth-user")).toContainText("team_admin");
  expect(reads()).toMatchObject({ writes: 0, legacyBroadReads: 0, legacyOtherReads: 0 });
});

test("KEYCLOAK-LIVE-042 4096바이트를 넘는 이름을 키보드로 선택하고 식별자만 SSO로 전달한다", async ({
  page,
}) => {
  const { detail, reads } = await openSkillBridge(page, "new-operator", "a".repeat(4097), true);
  await expect(detail).toContainText("선택한 스킬 지침");
  expect(new URL(page.url()).hash.length).toBeLessThan(100);
  expect(reads()).toMatchObject({ writes: 0, legacyBroadReads: 0, legacyOtherReads: 0 });
});
test("KEYCLOAK-LIVE-043 보호된 이름을 식별자로 열어도 실제 읽기 전용 권한을 유지한다", async ({ page }) => {
  const { detail, reference, reads } = await openSkillBridge(page, "reader", "vc_sk_" + "x".repeat(43), true);
  await expect(detail).toContainText("선택한 스킬 지침");
  expect(new URL(page.url()).hash).not.toContain("vc_sk_");
  expect(reads().writes).toBe(0);
  const status = await page.evaluate(
    async (ref) =>
      (
        await fetch("/admin/skills?skill_ref=" + ref, {
          method: "DELETE",
          headers: { Authorization: "Bearer " + sessionStorage.getItem("authAccess") },
        })
      ).status,
    reference,
  );
  expect(status).toBe(401);
  await page.reload();
  await expect(detail).toContainText("선택한 스킬 지침");
});
test("KEYCLOAK-LIVE-044 가져온 이름과 메타데이터를 보존해 편집하고 정확한 근거 기록과 삭제를 수행한다", async ({
  page,
}) => {
  await signIn(page, "new-operator");
  const name = " /imported-skill/ ";
  const before = await nativeSkill(page, name);
  const aliasBefore = await nativeSkill(page, "/imported-skill/");
  const writes: { path: string; query: string; body: Record<string, unknown> | null }[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/admin/skills") && request.method() !== "GET")
      writes.push({
        path: url.pathname,
        query: url.search,
        body: request.postDataJSON() as Record<string, unknown> | null,
      });
  });
  await page.goto("/app/agents/skills?skill_ref=" + before.skill_ref + "&status=production");
  const detail = page.getByRole("dialog", { name: name.trim(), exact: true });
  await expect(detail).toBeVisible();
  await detail.getByRole("button", { name: "편집", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "스킬 수정 · " + name.trim(), exact: true });
  await expect(editor.getByLabel("이름", { exact: false })).toHaveValue(name);
  await editor.getByLabel("설명", { exact: true }).fill("after-exact-edit");
  await editor.getByRole("button", { name: "수정 저장", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const after = await nativeSkill(page, name);
  expect(after).toMatchObject({
    name,
    skill_ref: before.skill_ref,
    metadata: before.metadata,
    owner: before.owner,
    version: before.version,
    description: "after-exact-edit",
  });
  expect(await nativeSkill(page, "/imported-skill/")).toEqual(aliasBefore);
  await detail.getByRole("button", { name: "정책 시뮬레이션", exact: true }).click();
  await detail.getByRole("button", { name: "정책 확인", exact: true }).click();
  await expect(detail.getByText("허용", { exact: true })).toBeVisible();
  expect(writes.find((write) => write.path.endsWith("/evaluate"))?.body).toMatchObject({
    skill_ref: before.skill_ref,
  });
  expect(writes.find((write) => write.path.endsWith("/evaluate"))?.body).not.toHaveProperty("name");
  await detail.getByRole("button", { name: "적합성 근거", exact: true }).click();
  await detail.getByRole("button", { name: "근거 기록", exact: true }).click();
  const fitness = page.getByRole("dialog", { name: "스킬 적합성 근거 기록", exact: true });
  await fitness.getByLabel("참조 ID", { exact: false }).fill("native-reference-proof");
  await fitness.getByRole("checkbox", { name: /^통과/u }).check();
  await fitness.getByRole("button", { name: "근거 기록 저장", exact: true }).click();
  await expect(fitness).toHaveCount(0);
  await expect(detail.getByRole("table", { name: "스킬 모델 적합성 근거", exact: true })).toContainText(
    "native-reference-proof",
  );
  expect(writes.find((write) => write.path.endsWith("/fitness"))?.body).toMatchObject({
    skill_ref: before.skill_ref,
  });
  expect(writes.find((write) => write.path.endsWith("/fitness"))?.body).not.toHaveProperty("skill");
  await detail.getByRole("button", { name: "삭제", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "스킬 삭제", exact: true });
  await confirm.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(detail).toHaveCount(0);
  expect(writes.filter((write) => write.path.includes("/by-name/"))).toHaveLength(0);
  expect(writes.at(-1)).toMatchObject({ path: "/admin/skills", query: "?skill_ref=" + before.skill_ref });
  expect(await nativeSkill(page, "/imported-skill/")).toEqual(aliasBefore);
});

const sessionHandoffID = "세션 +%2F?&#";
async function openSessionBridge(page: Page, username: string, id = sessionHandoffID) {
  await signIn(page, username);
  let writes = 0,
    broadReads = 0,
    exactReads = 0,
    legacy = false;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/admin/") && request.method() !== "GET") writes++;
    if (legacy && (url.pathname === "/admin/sessions" || url.pathname === "/admin/sessions/page"))
      broadReads++;
    if (url.pathname.startsWith("/admin/sessions/") && url.pathname.endsWith("/flight-recorder"))
      exactReads++;
  });
  await page.goto(
    "/app/observability/sessions?" + new URLSearchParams({ session_id: id, days: "7", q: "not-in-list" }),
  );
  const sheet = page.getByRole("dialog", { name: "세션 비행기록", exact: true });
  await expect(sheet).toBeVisible();
  const href = "/admin#/sessions?" + new URLSearchParams({ session_id: id });
  const link = sheet.getByRole("link", { name: "기존 화면에서 같은 세션 열기", exact: true });
  await expect(link).toHaveAttribute("href", href);
  await link.focus();
  legacy = true;
  await page.keyboard.press("Enter");
  await expect(page.locator("#login-backdrop.open")).toBeVisible();
  await page.getByRole("button", { name: "SSO 로그인 (Keycloak)", exact: true }).click();
  const detail = page.locator("#legacy-session-detail");
  await expect(detail.getByRole("region", { name: "선택한 세션 기록", exact: true })).toBeVisible();
  await expect(page).toHaveURL(gateway + href);
  expect(await page.evaluate(() => sessionStorage.getItem("vibe.admin.auth.sso-return-to"))).toBeNull();
  return { detail, reads: () => ({ writes, broadReads, exactReads }) };
}
test("KEYCLOAK-LIVE-045 마스킹된 세션 표시와 실제 대상을 구분해 SSO로 연결하고 로그아웃 시 지운다", async ({
  page,
}) => {
  const { detail, reads } = await openSessionBridge(page, "reader", "reader-session@example.invalid");
  await expect(detail).toContainText("[REDACTED_EMAIL]");
  await expect(detail).not.toContainText("reader-session@example.invalid");
  await expect(detail).not.toContainText("RAW_SESSION_PRIVATE");
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
        const root = document.querySelector("#legacy-session-detail");
        if (!root) throw Error("Session detail missing");
        return (await axe.run(root, { rules: { "color-contrast": { enabled: true } } })).violations.length;
      }),
    ).toBe(0);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(reads()).toMatchObject({ writes: 0, broadReads: 0 });
  await page.locator("#auth-user").click();
  await page.locator("#auth-logout").click();
  await expect(page.locator("#login-backdrop.open")).toBeVisible();
  await expect(detail).toBeEmpty();
});
test("KEYCLOAK-LIVE-046 세션 목록 기간 밖 기록과 팀 권한을 유지하고 외부 팀은 조회하지 않는다", async ({
  page,
}) => {
  const { detail, reads } = await openSessionBridge(page, "routing-reader");
  await expect(detail).toContainText("OWN_SESSION_CURRENT");
  await expect(detail).toContainText("OWN_SESSION_OLD");
  await expect(detail).not.toContainText("FOREIGN_SESSION_SHARED");
  await expect(detail).not.toContainText("RAW_SESSION_PRIVATE");
  await page.goto("/admin#/sessions?session_id=foreign-session-only");
  await expect(detail).toContainText("선택한 세션을 불러오지 못했습니다");
  await expect(detail).not.toContainText("FOREIGN_SESSION_ONLY");
  await expect(detail).not.toContainText("OWN_SESSION_CURRENT");
  expect(reads()).toMatchObject({ writes: 0, broadReads: 0 });
});
test("KEYCLOAK-LIVE-047 최대 UTF8 세션 ID를 SSO로 유지하고 같은 요청 상세를 명시적으로 연다", async ({
  page,
}) => {
  const { detail, reads } = await openSessionBridge(page, "new-operator", "😀".repeat(1024));
  await expect(detail).toContainText("MAX_SESSION_PREVIEW");
  expect(reads()).toMatchObject({ writes: 0, broadReads: 0 });
  const request = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/admin/requests/session-max",
  );
  await detail.getByRole("button", { name: "상세", exact: true }).click();
  await request;
  expect(reads().writes).toBe(0);
});
test("KEYCLOAK-LIVE-048 잘못된 세션 주소와 늦은 전체 목록이 현재 상세를 바꾸지 않는다", async ({ page }) => {
  const { detail, reads } = await openSessionBridge(page, "new-operator");
  const before = reads().exactReads;
  await page.goto("/admin#/sessions?session_id=one&session_id=two");
  await expect(detail).toContainText("세션 상세 주소가 올바르지 않습니다");
  expect(reads().exactReads).toBe(before);
  let captured = false,
    completed = false,
    release: () => void = () => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  await page.route("**/admin/sessions?days=*", async (route) => {
    const response = await route.fetch();
    captured = true;
    await gate;
    await route.fulfill({ response }).catch(() => {});
    completed = true;
  });
  await detail.getByRole("link", { name: "세션 전체 화면 열기", exact: true }).click();
  await expect.poll(() => captured).toBe(true);
  await page.goto("/admin#/sessions?" + new URLSearchParams({ session_id: sessionHandoffID }));
  await expect(detail).toContainText("OWN_SESSION_CURRENT");
  release();
  await expect.poll(() => completed).toBe(true);
  await page.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  await expect(detail).toContainText("OWN_SESSION_CURRENT");
  await expect(page.locator("#sess-days")).toHaveCount(0);
  expect(reads().writes).toBe(0);
});

test("KEYCLOAK-LIVE-049 같은 요청을 연 상태에서 권한이 갱신되면 확인한 원문을 지운다", async ({ page }) => {
  await signIn(page, "new-operator");
  await page.setViewportSize({ width: 1440, height: 900 });
  let authorization = "",
    rawReads = 0,
    refreshes = 0,
    expiredOnce = false;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== gateway) return;
    if (url.pathname === "/admin/requests/session-own-current/io") {
      authorization = request.headers()["authorization"] ?? authorization;
      if (url.searchParams.get("reveal") === "raw") rawReads++;
    }
    if (url.pathname === "/auth/refresh") refreshes++;
  });
  await page.goto("/app/observability/io?request_id=session-own-current&live=off");
  const panel = page.getByRole("region", { name: "선택한 요청의 입력과 출력", exact: true });
  await expect(panel.getByText("OWN_SESSION_CURRENT", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "원문 보기", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "이 요청의 원문을 볼까요?", exact: true });
  expect(rawReads).toBe(0);
  await dialog.getByRole("button", { name: "원문 보기", exact: true }).click();
  await expect(panel.getByText("RAW_SESSION_PRIVATE", { exact: true })).toBeVisible();
  expect(rawReads).toBe(1);
  const control = process.env.VIBE_GRANT_CONTROL;
  if (!control || !authorization) throw Error("Private fixture state missing");
  try {
    const changed = await page.request.post("/__fixture/grants", {
      headers: { "X-Fixture-Control": control, Authorization: authorization },
      data: { operation: "role" },
    });
    expect(changed.status()).toBe(200);
    const body = (await changed.json()) as { expired_access: string };
    await page.route("**/admin/ui-bootstrap", async (route) => {
      if (!expiredOnce) {
        expiredOnce = true;
        await route.continue({
          headers: { ...route.request().headers(), authorization: "Bearer " + body.expired_access },
        });
      } else await route.continue();
    });
    // Credential rotation alone does not refresh AuthProvider's grant metadata.
    // Exercise the actual visibility bootstrap, including its expired-token retry.
    const bootstrapResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/admin/ui-bootstrap" && response.status() === 200,
    );
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    const refreshed = (await (await bootstrapResponse).json()) as { user: { role: string } };
    expect(refreshed.user.role).toBe("readonly_admin");
    await expect.poll(() => refreshes).toBe(1);
    await expect(panel.getByText("OWN_SESSION_CURRENT", { exact: true })).toBeVisible();
    await expect(page.getByText("RAW_SESSION_PRIVATE", { exact: true })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "원문 보기", exact: true })).toHaveCount(0);
    expect(rawReads).toBe(1);
    expect(new URL(page.url()).searchParams.get("request_id")).toBe("session-own-current");
  } finally {
    await restoreGrantFixture(page);
  }
});
