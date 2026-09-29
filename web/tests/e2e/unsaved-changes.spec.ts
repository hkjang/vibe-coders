import { expect, test as base, type BrowserContext, type Locator, type Page } from "@playwright/test";

import type { UiBootstrapResponse } from "../../src/shared/api/generated";

const draftName = "unsaved-fixture-provider";
const providerUrl = "https://provider.example.invalid/v1";
const guardTitle = "저장하지 않은 변경사항이 있습니다";
const user = {
  id: "unsaved-e2e-admin",
  email: "unsaved@example.invalid",
  name: "편집 보호 운영자",
  role: "admin",
  roles: ["admin"],
  team_id: "fixture-team",
  scopes: ["admin:read", "admin:write", "routing:read"],
  features: { "gateway.providers": true, "gateway.health": true },
};

function bootstrap(authenticated: boolean): UiBootstrapResponse {
  return {
    backend_version: "v0.86.4",
    ui_version: "unsaved-e2e",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/gateway/providers",
      legacy_fallback: true,
      feedback_enabled: false,
      telemetry_enabled: false,
    },
    authentication: {
      enabled: true,
      authenticated,
      mode: "session",
      keycloak_enabled: false,
      allow_local_login: true,
      sso_login_url: "/auth/keycloak/login",
    },
    ...(authenticated ? { user } : {}),
    capabilities: { raw_prompt_view: false },
    roles: authenticated ? user.roles : [],
    permissions: authenticated ? user.scopes : [],
    allowed_features: authenticated ? ["gateway.providers", "gateway.health"] : [],
    migration_registry: [
      {
        feature_id: "gateway.providers",
        title: "AI 공급자",
        app_path: "/app/gateway/providers",
        legacy_path: "/admin#/settings",
        status: "preview",
        risk_level: "medium",
        required_permission: "admin:read",
        read_only: false,
        enabled_roles: ["admin"],
        rollout_percent: 100,
        fallback_enabled: true,
        minimum_api_version: "v0.84.0",
        available: authenticated,
      },
      {
        feature_id: "gateway.health",
        title: "게이트웨이 상태",
        app_path: "/app/gateway/health",
        legacy_path: "/admin#/routing/health",
        status: "preview_read_only",
        risk_level: "low",
        required_permission: "routing:read",
        read_only: true,
        enabled_roles: ["admin"],
        rollout_percent: 100,
        fallback_enabled: true,
        minimum_api_version: "v0.84.0",
        available: authenticated,
      },
    ],
    system_status: { status: "healthy" },
    legacy_route_map: {
      "/app/gateway/providers": "/admin#/settings",
      "/app/gateway/health": "/admin#/routing/health",
    },
  };
}

async function installGateway(context: BrowserContext) {
  const sessions = new Map<string, string>();
  const unexpected: string[] = [];
  let loginCount = 0;
  let logoutCount = 0;
  let saveCount = 0;
  const savePayloads: unknown[] = [];
  let saveStatus = 200;
  let saveGate: Promise<void> | undefined;
  let releaseSave: (() => void) | undefined;

  await context.route("**/*", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const call = `${request.method()} ${path}`;
    const authorization = request.headers().authorization ?? "";
    const authenticated = sessions.has(authorization);
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "X-Request-ID": "req-unsaved-fixture" },
        body: JSON.stringify(body),
      });

    if (call === "POST /auth/login") {
      expect(request.postDataJSON()).toEqual({ email: user.email, password: "public-test-password" });
      loginCount += 1;
      const access = `public-fixture-access-${loginCount}`;
      const refresh = `public-fixture-refresh-${loginCount}`;
      sessions.set(`Bearer ${access}`, refresh);
      return json({
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_expires_in: 7200,
        user,
      });
    }
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap(authenticated));
    if (call === "GET /health") return json({ status: "ok" });
    if (call === "GET /ready") return json({ status: "ready" });
    if (path.startsWith("/admin/") || path.startsWith("/auth/")) {
      if (!authenticated) {
        unexpected.push(`unauthorized ${call}`);
        return json({ error: { message: "fixture authentication required" } }, 401);
      }
      if (call === "POST /auth/logout") {
        expect(request.postDataJSON()).toEqual({ refresh_token: sessions.get(authorization) });
        logoutCount += 1;
        sessions.delete(authorization);
        return json({ ok: true });
      }
      if (call === "GET /admin/providers") return json({ providers: [] });
      if (call === "GET /admin/providers/slo")
        return json({ slos: [], evaluations: [], since: "2026-09-29T00:00:00Z" });
      if (call === "GET /admin/routing/balancer")
        return json({
          mode: "session_hash",
          multi_instance_safe: true,
          sticky_sessions: true,
          sticky_ttl: "30m0s",
          active_sessions: 0,
          balance_index: 1,
          pools: [],
        });
      if (call === "GET /admin/routing/health")
        return json({
          since: "2026-09-28T00:00:00Z",
          until: "2026-09-29T00:00:00Z",
          threshold: 70,
          providers: [],
          ranking: [],
          degraded: [],
          alerts: [],
          trend: [],
          breakers: {
            enabled: false,
            threshold: 5,
            cooldown_seconds: 30,
            states: [],
            shared: false,
            instance_id: "fixture",
          },
        });
      if (call === "POST /admin/providers") {
        saveCount += 1;
        savePayloads.push(request.postDataJSON());
        // Only non-secret synthetic fields are entered in this suite.
        expect(request.postDataJSON()).toMatchObject({ name: draftName, base_url: providerUrl });
        expect(request.postDataJSON()).not.toHaveProperty("api_key");
        if (saveGate) await saveGate;
        return saveStatus === 200
          ? json({ provider: { name: draftName } })
          : json({ error: { message: "fixture save failed", code: "provider_save_failed" } }, saveStatus);
      }
      unexpected.push(call);
      return json({ error: { message: "unexpected fixture request" } }, 501);
    }
    return route.continue();
  });
  return {
    unexpected,
    loginCount: () => loginCount,
    logoutCount: () => logoutCount,
    saveCount: () => saveCount,
    savePayloads: () => savePayloads,
    failSaves: () => {
      saveStatus = 503;
    },
    holdSaves: () => {
      saveGate = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
    },
    releaseSaves: () => releaseSave?.(),
  };
}

type Gateway = Awaited<ReturnType<typeof installGateway>>;
const test = base.extend<{ gateway: Gateway }>({
  gateway: async ({ context }, run) => {
    const gateway = await installGateway(context);
    try {
      await run(gateway);
    } finally {
      gateway.releaseSaves();
      expect(gateway.unexpected).toEqual([]);
    }
  },
});

async function login(page: Page) {
  await page.goto("login?return_to=%2Fapp%2Fgateway%2Fproviders");
  await signIn(page);
}

async function signIn(page: Page) {
  await expect(page.getByRole("heading", { name: "관리자 로그인" })).toBeVisible();
  await page.getByLabel("이메일", { exact: true }).fill(user.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("button", { name: "공급자 추가", exact: true })).toBeVisible();
}

async function openForm(page: Page, dirty = true): Promise<Locator> {
  await page.getByRole("button", { name: "공급자 추가", exact: true }).click();
  const form = page.getByRole("dialog", { name: "공급자 추가", exact: true });
  await expect(form).toBeVisible();
  if (dirty) {
    await form.getByLabel(/^이름/u).fill(draftName);
    await form.getByLabel(/^기본 URL/u).fill(providerUrl);
  }
  return form;
}

async function closeForm(page: Page, form: Locator, method: "Escape" | "취소" | "외부 클릭") {
  if (method === "Escape") await page.keyboard.press("Escape");
  else if (method === "취소") await form.getByRole("button", { name: "취소", exact: true }).click();
  else await page.mouse.click(8, 8);
}

const guard = (page: Page) => page.getByRole("alertdialog", { name: guardTitle });

async function axeViolations(page: Page) {
  return page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (root: Document) => Promise<{
            violations: {
              id: string;
              impact: string | null;
              nodes: { target: string[]; failureSummary?: string }[];
            }[];
          }>;
        };
      }
    ).axe;
    return (await axe.run(document)).violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    }));
  });
}

for (const method of ["Escape", "취소", "외부 클릭"] as const) {
  test(`변경한 공급자 폼의 ${method}는 계속 편집과 명시적 폐기를 제공한다`, async ({ page, gateway }) => {
    await login(page);
    const form = await openForm(page);
    await closeForm(page, form, method);
    await expect(guard(page)).toBeVisible();
    await expect(guard(page).getByRole("button", { name: "계속 편집" })).toBeFocused();
    await guard(page).getByRole("button", { name: "계속 편집" }).click();
    await expect(guard(page)).toBeHidden();
    await expect(form.getByLabel(/^이름/u)).toHaveValue(draftName);
    await expect(form.getByLabel(/^기본 URL/u)).toHaveValue(providerUrl);
    await expect.poll(() => form.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await closeForm(page, form, method);
    await guard(page).getByRole("button", { name: "변경 버리기" }).click();
    await expect(form).toBeHidden();
    await expect(page.getByRole("button", { name: "공급자 추가", exact: true })).toBeFocused();
    const reopened = await openForm(page, false);
    await expect(reopened.getByLabel(/^이름/u)).toHaveValue("");
    await expect(reopened.getByLabel(/^기본 URL/u)).toHaveValue("");
    expect(gateway.saveCount()).toBe(0);
  });
}

test("변경하지 않은 폼은 경고 없이 닫히고 저장 성공은 중복 요청이나 폐기 경고가 없다", async ({
  page,
  gateway,
}) => {
  await login(page);
  for (const method of ["Escape", "취소", "외부 클릭"] as const) {
    const clean = await openForm(page, false);
    await closeForm(page, clean, method);
    await expect(clean).toBeHidden();
    await expect(guard(page)).toBeHidden();
  }
  const invalid = await openForm(page, false);
  await invalid.getByRole("button", { name: "저장", exact: true }).click();
  await expect(invalid.getByText("공급자 이름을 입력하세요.", { exact: true })).toBeVisible();
  await expect(invalid.getByText("기본 URL을 입력하세요.", { exact: true })).toBeVisible();
  await expect(invalid.getByLabel(/^이름/u)).toBeEnabled();
  await expect(invalid.getByLabel(/^이름/u)).toBeFocused();
  expect(gateway.saveCount()).toBe(0);
  await closeForm(page, invalid, "취소");
  await expect(invalid).toBeHidden();
  await expect(guard(page)).toBeHidden();
  const form = await openForm(page);
  await form.getByLabel("모델 패턴", { exact: true }).fill("fixture-model-*");
  gateway.holdSaves();
  await form.getByRole("button", { name: "저장", exact: true }).dblclick();
  await expect.poll(gateway.saveCount).toBe(1);
  await expect(form.getByRole("button", { name: "저장 중", exact: true })).toBeDisabled();
  await expect(form.getByLabel(/^이름/u)).toBeDisabled();
  await expect(form.getByLabel(/^기본 URL/u)).toBeDisabled();
  await expect(form.getByLabel("모델 패턴", { exact: true })).toBeDisabled();
  await expect(form.getByRole("checkbox", { name: /^활성/u })).toBeDisabled();
  const submitted = structuredClone(gateway.savePayloads());
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toMatchObject({
    name: draftName,
    base_url: providerUrl,
    model_patterns: "fixture-model-*",
    enabled: true,
  });
  await page.keyboard.press("Escape");
  await expect(form).toBeVisible();
  await expect(guard(page)).toBeHidden();
  await expect(form.getByLabel(/^이름/u)).toHaveValue(draftName);
  await expect(form.getByLabel(/^기본 URL/u)).toHaveValue(providerUrl);
  await expect(form.getByLabel("모델 패턴", { exact: true })).toHaveValue("fixture-model-*");
  expect(gateway.savePayloads()).toEqual(submitted);
  gateway.releaseSaves();
  await expect(form).toBeHidden();
  await expect(guard(page)).toBeHidden();
  expect(gateway.saveCount()).toBe(1);
  expect(gateway.savePayloads()).toEqual(submitted);
});

test("저장 실패는 입력값과 보호를 유지하고 자동 재전송하지 않는다", async ({ page, gateway }) => {
  await login(page);
  gateway.failSaves();
  const form = await openForm(page);
  gateway.holdSaves();
  await form.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(gateway.saveCount).toBe(1);
  await expect(form.getByLabel(/^이름/u)).toBeDisabled();
  await expect(form.getByLabel("모델 패턴", { exact: true })).toBeDisabled();
  gateway.releaseSaves();
  await expect(form.getByRole("alert")).toContainText("req-unsaved-fixture");
  await expect(form.getByLabel(/^이름/u)).toBeEnabled();
  await expect(form.getByLabel(/^기본 URL/u)).toBeEnabled();
  await expect(form.getByLabel("모델 패턴", { exact: true })).toBeEnabled();
  await expect(form.getByRole("checkbox", { name: /^활성/u })).toBeEnabled();
  await form.getByLabel("모델 패턴", { exact: true }).fill("edited-after-failure-*");
  await expect(form.getByLabel(/^이름/u)).toHaveValue(draftName);
  await closeForm(page, form, "Escape");
  await expect(guard(page)).toBeVisible();
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  await expect(form.getByLabel(/^기본 URL/u)).toHaveValue(providerUrl);
  await expect(form.getByLabel("모델 패턴", { exact: true })).toHaveValue("edited-after-failure-*");
  expect(gateway.saveCount()).toBe(1);
});

test("실제 뒤로가기를 취소해 편집을 유지하고 재시도 후 폐기하면 이동한다", async ({ page, gateway }) => {
  await login(page);
  await page
    .getByRole("complementary", { name: "주 메뉴" })
    .getByRole("link", { name: /게이트웨이 상태/u })
    .click();
  await expect(page).toHaveURL(/\/gateway\/health$/u);
  await page
    .getByRole("complementary", { name: "주 메뉴" })
    .getByRole("link", { name: /AI 공급자/u })
    .click();
  await expect(page).toHaveURL(/\/gateway\/providers$/u);
  const form = await openForm(page);
  await page.goBack();
  await expect(guard(page)).toBeVisible();
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  await expect(page).toHaveURL(/\/gateway\/providers$/u);
  await expect(form.getByLabel(/^이름/u)).toHaveValue(draftName);
  await page.goBack();
  await expect(guard(page)).toBeVisible();
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  await expect(page).toHaveURL(/\/gateway\/health$/u);
  await expect(form).toBeHidden();
  expect(gateway.saveCount()).toBe(0);
});

test("desktop Chromium 새로고침은 실제 beforeunload 경고를 제공하고 취소하면 초안을 유지한다", async ({
  page,
  gateway,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Native beforeunload contract is verified on desktop Chromium.");
  await login(page);
  const form = await openForm(page);
  const dialogEvent = page.waitForEvent("dialog");
  // A canceled reload has no navigation completion event for page.reload() to await.
  // Trigger the real browser navigation without replacing the beforeunload event.
  await page.evaluate(() => {
    setTimeout(() => window.location.reload(), 0);
  });
  const dialog = await dialogEvent;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
  await expect(form.getByLabel(/^이름/u)).toHaveValue(draftName);
  await closeForm(page, form, "취소");
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  let extraNativeDialogs = 0;
  page.on("dialog", async (event) => {
    extraNativeDialogs += 1;
    await event.dismiss();
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "공급자 추가", exact: true })).toBeVisible();
  expect(extraNativeDialogs).toBe(0);
  expect(gateway.saveCount()).toBe(0);
});

test("다른 탭의 실제 로그아웃은 미저장 확인도 폐기하며 재로그인에 이전 초안을 복원하지 않는다", async ({
  page,
  context,
  gateway,
}) => {
  await login(page);
  const other = await context.newPage();
  await login(other);
  const form = await openForm(page);
  await closeForm(page, form, "Escape");
  await expect(guard(page)).toBeVisible();
  await other.getByLabel("사용자 메뉴").click();
  await other.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect.poll(gateway.logoutCount).toBe(1);
  await expect(page.getByRole("heading", { name: "관리자 로그인" })).toBeVisible();
  await expect(other.getByRole("heading", { name: "관리자 로그인" })).toBeVisible();
  await expect(guard(page)).toBeHidden();
  await expect(form).toBeHidden();
  await signIn(page);
  const reopened = await openForm(page, false);
  await expect(reopened.getByLabel(/^이름/u)).toHaveValue("");
  await expect(reopened.getByLabel(/^기본 URL/u)).toHaveValue("");
  expect(gateway.loginCount()).toBe(3);
  expect(gateway.saveCount()).toBe(0);
  const stored = await page.evaluate(() => [
    ...Object.values(localStorage),
    ...Object.values(sessionStorage),
  ]);
  expect(stored.join("\n")).not.toContain(draftName);
  expect(stored.join("\n")).not.toContain(providerUrl);
});

test("한글 미저장 확인은 접근성 위반 없이 포커스를 가두고 Escape로 편집에 돌아간다", async ({
  page,
  gateway,
}) => {
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await login(page);
  const form = await openForm(page);
  await closeForm(page, form, "Escape");
  const alert = guard(page);
  await expect(alert).toBeVisible();
  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press("Tab");
    await expect.poll(() => alert.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  expect(await axeViolations(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(alert).toBeHidden();
  await expect(form.getByLabel(/^이름/u)).toHaveValue(draftName);
  expect(gateway.saveCount()).toBe(0);
});

test("로그아웃 전 저장의 늦은 응답은 재로그인 후 새 편집창을 닫거나 이전 초안을 되살리지 않는다", async ({
  page,
  context,
  gateway,
}) => {
  await login(page);
  const other = await context.newPage();
  await login(other);
  const oldForm = await openForm(page);
  gateway.holdSaves();
  await oldForm.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(gateway.saveCount).toBe(1);
  await other.getByLabel("사용자 메뉴").click();
  await other.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page.getByRole("heading", { name: "관리자 로그인" })).toBeVisible();
  await expect(guard(page)).toBeHidden();
  // Reauthenticate through the existing SPA login form: a full page.goto here
  // would abort the old request instead of exercising its late completion.
  await signIn(page);
  const fresh = await openForm(page, false);
  await expect(fresh.getByLabel(/^이름/u)).toHaveValue("");
  await fresh.getByLabel(/^이름/u).fill("fresh-session-fixture");
  const oldResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/admin/providers" && response.request().method() === "POST",
  );
  gateway.releaseSaves();
  await (await oldResponse).finished();
  await expect(fresh).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(guard(page)).toBeVisible();
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  await expect(fresh.getByLabel(/^이름/u)).toHaveValue("fresh-session-fixture");
  await expect(fresh.getByLabel(/^기본 URL/u)).toHaveValue("");
  expect(gateway.saveCount()).toBe(1);
  expect(gateway.logoutCount()).toBe(1);
});

test("390px 다크 화면의 미저장 확인은 넘침 없이 읽고 키보드로 조작할 수 있다", async ({
  page,
  gateway,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await login(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const form = await openForm(page);
  await closeForm(page, form, "Escape");
  const alert = guard(page);
  await expect(alert).toBeVisible();
  await expect(alert.getByRole("button", { name: "계속 편집" })).toBeInViewport();
  await expect(alert.getByRole("button", { name: "변경 버리기" })).toBeInViewport();
  const layout = await page.evaluate(() => ({
    width: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(layout.document).toBeLessThanOrEqual(layout.width);
  expect(layout.body).toBeLessThanOrEqual(layout.width);
  await page.screenshot({ path: testInfo.outputPath("unsaved-mobile-dark.png"), fullPage: true });
  expect(await axeViolations(page)).toEqual([]);
  await expect(alert.getByRole("button", { name: "계속 편집" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(alert.getByRole("button", { name: "변경 버리기" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(alert).toBeHidden();
  await expect(form.getByLabel(/^이름/u)).toHaveValue(draftName);
  expect(gateway.saveCount()).toBe(0);
});
