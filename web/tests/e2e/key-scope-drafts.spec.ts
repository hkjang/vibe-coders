import { expect, test as base, type BrowserContext, type Locator, type Page } from "@playwright/test";

import type { UiBootstrapResponse } from "../../src/shared/api/generated";

const targetUrl = "/app/access/users?tab=keys";
const guardTitle = "저장하지 않은 변경사항이 있습니다";
const unknownScope = "fixture:extension:retained-permission-with-a-long-synthetic-identifier";
const user = {
  id: "scope-drafts-e2e-admin",
  email: "scope-drafts@example.invalid",
  name: "권한 초안 운영자",
  role: "admin",
  roles: ["admin"],
  team_id: "fixture-team",
  scopes: ["admin:read", "admin:write"],
  features: { "access.users": true, "gateway.providers": true },
};

interface PublicKey {
  id: string;
  name: string;
  owner: string;
  team: string;
  role: string;
  status: string;
  scopes: string[];
}

function publicKey(id: string, name: string, scopes: string[]): PublicKey {
  return {
    id,
    name,
    owner: "fixture-owner",
    team: "fixture-team",
    role: "developer",
    status: "active",
    scopes,
  };
}

const alpha = publicKey("public-scope-key-alpha", "scope-draft-alpha", ["models:read", unknownScope]);
const beta = publicKey("public-scope-key-beta", "scope-draft-beta", ["models:read"]);
const inherited = publicKey("public-scope-key-inherited", "scope-draft-inherited", []);

function bootstrap(authenticated: boolean): UiBootstrapResponse {
  return {
    backend_version: "v0.86.10",
    ui_version: "scope-drafts-e2e",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: targetUrl,
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
    allowed_features: authenticated ? ["access.users", "gateway.providers"] : [],
    migration_registry: [
      {
        feature_id: "access.users",
        title: "사용자와 팀",
        app_path: "/app/access/users",
        legacy_path: "/admin#/users",
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
    ],
    system_status: { status: "healthy" },
    legacy_route_map: {
      "/app/access/users": "/admin#/users",
      "/app/gateway/providers": "/admin#/settings",
    },
  };
}

async function installGateway(context: BrowserContext) {
  const sessions = new Map<string, string>();
  const unexpected: string[] = [];
  const saves: { id: string; body: { scopes: string[] } }[] = [];
  let keys = structuredClone([alpha, beta, inherited]);
  let reads = 0;
  let loginCount = 0;
  let logoutCount = 0;
  let logoutResponseCount = 0;
  let saveStatus = 200;
  let saveGate: Promise<void> | undefined;
  let releaseSave: (() => void) | undefined;
  let logoutGate: Promise<void> | undefined;
  let releaseLogout: (() => void) | undefined;

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
        headers: { "X-Request-ID": "req-key-scope-draft" },
        body: JSON.stringify(body),
      });

    if (call === "POST /auth/login") {
      expect(request.postDataJSON()).toEqual({ email: user.email, password: "public-test-password" });
      loginCount += 1;
      const access = `public-scope-access-${loginCount}`;
      const refresh = `public-scope-refresh-${loginCount}`;
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
        if (logoutGate) await logoutGate;
        await json({ ok: true });
        logoutResponseCount += 1;
        return;
      }
      if (call === "GET /admin/api-keys") {
        reads += 1;
        return json({ api_keys: keys });
      }
      if (call === "GET /admin/users") return json({ users: [], auth_users: [], team_names: {} });
      if (call === "GET /admin/benchmark/users") return json({ users: [] });
      if (call === "GET /admin/providers") return json({ providers: [] });
      if (call === "GET /admin/providers/slo")
        return json({ slos: [], evaluations: [], since: "2026-09-30T00:00:00Z" });

      const id = path.match(/^\/admin\/api-keys\/([^/]+)$/u)?.[1];
      if (request.method() === "PATCH" && id) {
        const body = request.postDataJSON() as { scopes: string[] };
        // Only public fixture IDs and permissions enter this suite; no key secret is issued.
        expect(keys.some((key) => key.id === id)).toBe(true);
        expect(Object.keys(body)).toEqual(["scopes"]);
        expect(Array.isArray(body.scopes)).toBe(true);
        const snapshot = structuredClone({ id, body });
        saves.push(snapshot);
        const status = saveStatus;
        if (saveGate) await saveGate;
        if (status !== 200)
          return json({ error: { message: "fixture scope save failed", code: "scope_save_failed" } }, status);
        keys = keys.map((key) => (key.id === id ? { ...key, scopes: [...snapshot.body.scopes] } : key));
        return json(keys.find((key) => key.id === id));
      }
      unexpected.push(call);
      return json({ error: { message: "unexpected fixture request" } }, 501);
    }
    return route.continue();
  });

  return {
    unexpected,
    saves,
    reads: () => reads,
    logoutCount: () => logoutCount,
    logoutResponseCount: () => logoutResponseCount,
    replaceKeys: (next: PublicKey[]) => {
      keys = structuredClone(next);
    },
    failSaves: () => {
      saveStatus = 503;
    },
    succeedSaves: () => {
      saveStatus = 200;
    },
    holdSaves: () => {
      saveGate = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
    },
    releaseSaves: () => releaseSave?.(),
    holdLogouts: () => {
      logoutGate = new Promise<void>((resolve) => {
        releaseLogout = resolve;
      });
    },
    releaseLogouts: () => releaseLogout?.(),
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
      gateway.releaseLogouts();
      expect(gateway.unexpected).toEqual([]);
    }
  },
});

const guard = (page: Page) => page.getByRole("alertdialog", { name: guardTitle });
const scope = (form: Locator, id: string) => form.getByRole("checkbox", { name: new RegExp(id, "u") });
const scopeTrigger = (page: Page, keyName = alpha.name) =>
  page
    .getByRole("row")
    .filter({ has: page.getByText(keyName, { exact: true }) })
    .getByRole("button", { name: "권한 수정", exact: true });

async function signIn(page: Page) {
  await expect(page.getByRole("heading", { name: "관리자 로그인" })).toBeVisible();
  await page.getByLabel("이메일", { exact: true }).fill(user.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(scopeTrigger(page)).toBeVisible();
}

async function login(page: Page) {
  await page.goto(`login?return_to=${encodeURIComponent(targetUrl)}`);
  await signIn(page);
}

async function openForm(page: Page, keyName = alpha.name) {
  await scopeTrigger(page, keyName).click();
  const form = page.getByRole("dialog", { name: "API 키 권한 수정", exact: true });
  await expect(form).toBeVisible();
  return form;
}

type CloseMethod = "Escape" | "취소" | "외부 클릭" | "닫기 버튼";
async function closeForm(page: Page, form: Locator, method: CloseMethod) {
  if (method === "Escape") await page.keyboard.press("Escape");
  else if (method === "취소") await form.getByRole("button", { name: "취소", exact: true }).click();
  else if (method === "닫기 버튼") await form.getByRole("button", { name: "대화상자 닫기" }).click();
  else await page.mouse.click(8, 8);
}

async function clickTwice(button: Locator) {
  // Keep both clicks in one task to exercise the synchronous submission guard.
  await button.evaluate((element) => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
}

async function expectNoStoredDraft(page: Page) {
  const stored = await page.evaluate(() =>
    [...Object.values(localStorage), ...Object.values(sessionStorage)].join("\n"),
  );
  for (const value of [alpha.name, beta.name, unknownScope, "chat:completion", "embeddings:create"])
    expect(stored).not.toContain(value);
}

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

for (const method of ["Escape", "취소", "외부 클릭", "닫기 버튼"] as const) {
  test(`권한 초안의 ${method}는 계속 편집과 명시적 폐기 후 같은 키 작업으로 포커스 복귀를 제공한다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    const form = await openForm(page);
    await expect(form.getByRole("checkbox", { name: /^대화 생성/u })).toBeVisible();
    await expect(form.getByRole("checkbox", { name: /^기타 권한/u })).toBeChecked();
    await scope(form, "chat:completion").check();
    await closeForm(page, form, method);
    await expect(guard(page)).toBeVisible();
    await expect(guard(page).getByRole("button", { name: "계속 편집" })).toBeFocused();
    await guard(page).getByRole("button", { name: "계속 편집" }).click();
    await expect(guard(page)).toBeHidden();
    for (const id of ["models:read", unknownScope, "chat:completion"])
      await expect(scope(form, id)).toBeChecked();
    await expect.poll(() => form.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await closeForm(page, form, method);
    await guard(page).getByRole("button", { name: "변경 버리기" }).click();
    await expect(form).toBeHidden();
    await expect(scopeTrigger(page)).toBeFocused();
    const reopened = await openForm(page);
    await expect(scope(reopened, "chat:completion")).not.toBeChecked();
    await expect(scope(reopened, "models:read")).toBeChecked();
    await expect(scope(reopened, unknownScope)).toBeChecked();
    expect(gateway.saves).toEqual([]);
    await expectNoStoredDraft(page);
  });
}

test("변경하지 않거나 원복한 권한은 경고 없이 닫히며 전체 해제와 기존 빈 배열은 역할 상속으로 저장된다", async ({
  page,
  gateway,
}) => {
  await login(page);
  const clean = await openForm(page);
  await closeForm(page, clean, "취소");
  await expect(clean).toBeHidden();
  await expect(guard(page)).toBeHidden();
  const reverted = await openForm(page);
  await scope(reverted, "chat:completion").check();
  await scope(reverted, "chat:completion").uncheck();
  await closeForm(page, reverted, "Escape");
  await expect(reverted).toBeHidden();
  await expect(guard(page)).toBeHidden();
  expect(gateway.saves).toEqual([]);

  for (const key of [beta, inherited]) {
    const form = await openForm(page, key.name);
    await expect(form).toContainText(/역할.*상속/u);
    if (key === beta) await scope(form, "models:read").uncheck();
    await expect(form.locator('input[type="checkbox"]:checked')).toHaveCount(0);
    await form.getByRole("button", { name: "권한 저장", exact: true }).click();
    await expect(form).toBeHidden();
    await expect(guard(page)).toBeHidden();
    await expect(scopeTrigger(page, key.name)).toBeFocused();
    const reopened = await openForm(page, key.name);
    await expect(reopened.locator('input[type="checkbox"]:checked')).toHaveCount(0);
    await closeForm(page, reopened, "취소");
    await expect(reopened).toBeHidden();
  }
  expect(gateway.saves).toEqual([
    { id: beta.id, body: { scopes: [] } },
    { id: inherited.id, body: { scopes: [] } },
  ]);
});

test("목록이 갱신되고 행 순서가 바뀌어도 열린 키의 권한 스냅샷과 알 수 없는 권한을 보존한다", async ({
  page,
  gateway,
}) => {
  await page.clock.install();
  await login(page);
  await page.getByLabel("자동 새로고침 간격").selectOption("60");
  const form = await openForm(page);
  await scope(form, "chat:completion").check();
  const reads = gateway.reads();
  const newerAlpha = { ...alpha, name: "scope-refetched-alpha", scopes: ["embeddings:create"] };
  gateway.replaceKeys([beta, inherited, newerAlpha]);
  await page.clock.fastForward(60_100);
  await expect.poll(gateway.reads).toBeGreaterThan(reads);
  await expect(form).toContainText(alpha.name);
  await expect(form).not.toContainText(newerAlpha.name);
  for (const id of ["models:read", unknownScope, "chat:completion"])
    await expect(scope(form, id)).toBeChecked();
  await expect(scope(form, "embeddings:create")).not.toBeChecked();
  await form.getByRole("button", { name: "권한 저장", exact: true }).click();
  await expect(form).toBeHidden();
  expect(gateway.saves).toEqual([
    { id: alpha.id, body: { scopes: ["chat:completion", unknownScope, "models:read"] } },
  ]);
  await expect(scopeTrigger(page, newerAlpha.name)).toBeFocused();
  await expect(scopeTrigger(page, beta.name)).not.toBeFocused();
  const reopened = await openForm(page, newerAlpha.name);
  for (const id of ["models:read", unknownScope, "chat:completion"])
    await expect(scope(reopened, id)).toBeChecked();
  await expect(scope(reopened, "embeddings:create")).not.toBeChecked();
});

test("저장 실패는 요청 ID와 초안을 유지하고 재시도는 그 시점의 권한만 한 번 전송한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  gateway.failSaves();
  const form = await openForm(page);
  await scope(form, "chat:completion").check();
  await form.getByRole("button", { name: "권한 저장", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("req-key-scope-draft");
  await expect(scope(form, "chat:completion")).toBeEnabled();
  await expect(scope(form, "chat:completion")).toBeChecked();
  await expect(scope(form, unknownScope)).toBeChecked();
  const first = structuredClone(gateway.saves);
  expect(first).toEqual([
    { id: alpha.id, body: { scopes: ["chat:completion", unknownScope, "models:read"] } },
  ]);
  await scope(form, "chat:completion").uncheck();
  await scope(form, "embeddings:create").check();
  await closeForm(page, form, "Escape");
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  await expect(form.getByRole("alert")).toContainText("req-key-scope-draft");
  await expect(scope(form, "embeddings:create")).toBeChecked();
  expect(gateway.saves).toEqual(first);
  gateway.succeedSaves();
  await form.getByRole("button", { name: "권한 저장", exact: true }).click();
  await expect(form).toBeHidden();
  expect(gateway.saves).toEqual([
    ...first,
    { id: alpha.id, body: { scopes: ["embeddings:create", unknownScope, "models:read"] } },
  ]);
  await expect(scopeTrigger(page)).toBeFocused();
});

test("저장 대기 중 체크박스와 취소를 잠그고 중복 제출과 모든 닫기 경로를 차단한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  const form = await openForm(page);
  await scope(form, "chat:completion").check();
  gateway.holdSaves();
  await clickTwice(form.getByRole("button", { name: "권한 저장", exact: true }));
  await expect.poll(() => gateway.saves.length).toBe(1);
  const submitted = structuredClone(gateway.saves);
  expect(submitted).toEqual([
    { id: alpha.id, body: { scopes: ["chat:completion", unknownScope, "models:read"] } },
  ]);
  for (const checkbox of await form.getByRole("checkbox").all()) await expect(checkbox).toBeDisabled();
  await expect(form.getByRole("button", { name: "취소", exact: true })).toBeDisabled();
  await expect(form.getByRole("button", { name: "저장 중", exact: true })).toBeDisabled();
  for (const method of ["Escape", "외부 클릭", "닫기 버튼"] as const) {
    await closeForm(page, form, method);
    await expect(form).toBeVisible();
    await expect(guard(page)).toBeHidden();
  }
  await form.locator("form").evaluate((element) => (element as HTMLFormElement).requestSubmit());
  await expect(scope(form, "chat:completion")).toBeChecked();
  await expect(scope(form, unknownScope)).toBeChecked();
  expect(gateway.saves).toEqual(submitted);
  gateway.releaseSaves();
  await expect(form).toBeHidden();
  await expect(guard(page)).toBeHidden();
  await expect(scopeTrigger(page)).toBeFocused();
  expect(gateway.saves).toEqual(submitted);
});

test("브라우저 뒤로가기를 취소하면 권한 초안을 유지하고 명시적 폐기하면 이전 화면으로 이동한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  const menu = page.getByRole("complementary", { name: "주 메뉴" });
  await menu.getByRole("link", { name: /AI 공급자/u }).click();
  await expect(page).toHaveURL(/\/gateway\/providers$/u);
  await menu.getByRole("link", { name: /사용자와 팀/u }).click();
  await page.getByRole("tab", { name: "API 키", exact: true }).click();
  const form = await openForm(page);
  await scope(form, "chat:completion").check();
  await page.goBack();
  await expect(guard(page)).toBeVisible();
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  await expect(page).toHaveURL(/\/access\/users\?tab=keys$/u);
  await expect(scope(form, "chat:completion")).toBeChecked();
  await page.goBack();
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  await expect(page).toHaveURL(/\/gateway\/providers$/u);
  await expect(form).toBeHidden();
  await expect(page.locator("#main-content")).toBeFocused();
  expect(gateway.saves).toEqual([]);
});

test("실제 새로고침의 beforeunload를 취소하면 권한 초안을 보존하고 폐기 후에는 경고하지 않는다", async ({
  page,
  gateway,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Native beforeunload is verified in desktop Chromium.");
  await login(page);
  const form = await openForm(page);
  await scope(form, "chat:completion").check();
  const dialogEvent = page.waitForEvent("dialog");
  await page.evaluate(() => {
    setTimeout(() => window.location.reload(), 0);
  });
  const dialog = await dialogEvent;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
  await expect(scope(form, "chat:completion")).toBeChecked();
  await closeForm(page, form, "취소");
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  let extraNativeDialogs = 0;
  page.on("dialog", async (event) => {
    extraNativeDialogs += 1;
    await event.dismiss();
  });
  await page.reload();
  await expect(scopeTrigger(page)).toBeVisible();
  expect(extraNativeDialogs).toBe(0);
  expect(gateway.saves).toEqual([]);
});

test("다른 탭의 로그아웃은 응답 대기 중에도 권한 초안과 폐기 확인을 지우고 재로그인에 복원하지 않는다", async ({
  page,
  context,
  gateway,
}) => {
  await login(page);
  const other = await context.newPage();
  await login(other);
  const form = await openForm(page);
  await scope(form, "chat:completion").check();
  await closeForm(page, form, "Escape");
  await expect(guard(page)).toBeVisible();
  gateway.holdLogouts();
  await other.getByLabel("사용자 메뉴").click();
  await other.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect.poll(gateway.logoutCount).toBe(1);
  await expect(page.getByRole("heading", { name: "관리자 로그인" })).toBeVisible();
  await expect(other.getByRole("heading", { name: "관리자 로그인" })).toBeVisible();
  await expect(form).toBeHidden();
  await expect(guard(page)).toBeHidden();
  expect(gateway.logoutResponseCount()).toBe(0);
  gateway.releaseLogouts();
  await expect.poll(gateway.logoutResponseCount).toBe(1);
  await signIn(page);
  const fresh = await openForm(page);
  await expect(scope(fresh, "chat:completion")).not.toBeChecked();
  await expect(scope(fresh, unknownScope)).toBeChecked();
  expect(gateway.saves).toEqual([]);
  await expectNoStoredDraft(page);
});

test("이전 세션의 늦은 저장 응답은 새 권한 초안을 닫거나 갱신하거나 성공 알림을 표시하지 않는다", async ({
  page,
  context,
  gateway,
}) => {
  await login(page);
  const other = await context.newPage();
  await login(other);
  const oldForm = await openForm(page);
  await scope(oldForm, "chat:completion").check();
  gateway.holdSaves();
  await oldForm.getByRole("button", { name: "권한 저장", exact: true }).click();
  await expect.poll(() => gateway.saves.length).toBe(1);
  const submitted = structuredClone(gateway.saves);
  await other.getByLabel("사용자 메뉴").click();
  await other.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page.getByRole("heading", { name: "관리자 로그인" })).toBeVisible();
  await expect(guard(page)).toBeHidden();
  // Stay in the SPA so the old request completes after a new session opens its own form.
  await signIn(page);
  const fresh = await openForm(page);
  await expect(scope(fresh, "chat:completion")).not.toBeChecked();
  await scope(fresh, "embeddings:create").check();
  const freshReads = gateway.reads();
  const oldResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/admin/api-keys/${alpha.id}` &&
      response.request().method() === "PATCH",
  );
  gateway.releaseSaves();
  await (await oldResponse).finished();
  await expect(fresh).toBeVisible();
  await expect(fresh).toContainText(alpha.name);
  await expect(scope(fresh, "embeddings:create")).toBeChecked();
  await expect(scope(fresh, "chat:completion")).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(guard(page)).toBeVisible();
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  await expect(scope(fresh, "embeddings:create")).toBeChecked();
  await expect(fresh.getByRole("alert")).toHaveCount(0);
  await expect(page.locator('[data-sonner-toast][data-type="success"]')).toHaveCount(0);
  expect(gateway.reads()).toBe(freshReads);
  expect(gateway.saves).toEqual(submitted);
  await expectNoStoredDraft(page);
  await fresh.getByRole("button", { name: "권한 저장", exact: true }).click();
  await expect(fresh).toBeHidden();
  await expect(scopeTrigger(page)).toBeFocused();
  expect(gateway.saves).toEqual([
    ...submitted,
    { id: alpha.id, body: { scopes: ["embeddings:create", unknownScope, "models:read"] } },
  ]);
});

test("390px 다크 화면에서 긴 기타 권한과 미저장 확인을 넘침이나 접근성 위반 없이 키보드로 조작한다", async ({
  page,
  gateway,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await login(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const form = await openForm(page);
  await expect(scope(form, unknownScope)).toBeChecked();
  await scope(form, "chat:completion").focus();
  await page.keyboard.press("Space");
  await expect(scope(form, "chat:completion")).toBeChecked();
  await expect(form.getByRole("button", { name: "권한 저장", exact: true })).toBeInViewport();
  const formLayout = await form.evaluate((element) => ({
    width: element.clientWidth,
    content: element.scrollWidth,
  }));
  expect(formLayout.content).toBeLessThanOrEqual(formLayout.width);
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("key-scope-mobile-dark.png") });
  await page.keyboard.press("Escape");
  const alert = guard(page);
  await expect(alert).toBeVisible();
  await expect(alert.getByRole("button", { name: "계속 편집" })).toBeFocused();
  await expect(alert.getByRole("button", { name: "변경 버리기" })).toBeInViewport();
  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press("Tab");
    await expect.poll(() => alert.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  const layout = await page.evaluate(() => ({
    width: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(layout.document).toBeLessThanOrEqual(layout.width);
  expect(layout.body).toBeLessThanOrEqual(layout.width);
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("key-scope-guard-mobile-dark.png") });
  await page.keyboard.press("Escape");
  await expect(alert).toBeHidden();
  await expect(scope(form, "chat:completion")).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(alert.getByRole("button", { name: "계속 편집" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(alert.getByRole("button", { name: "변경 버리기" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(form).toBeHidden();
  await expect(scopeTrigger(page)).toBeFocused();
  expect(gateway.saves).toEqual([]);
});
