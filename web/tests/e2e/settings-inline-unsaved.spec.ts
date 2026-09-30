import { expect, test as base, type BrowserContext, type Locator, type Page } from "@playwright/test";

import type { KeycloakConfig, NotificationConfig } from "../../src/shared/api/domains/system.schemas";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// Browser/UI contracts with an authenticated, stateful API fixture. These are
// not live OIDC, database CAS, encryption, webhook delivery, or multi-pod tests.
// Every credential-like value below is a public synthetic non-secret.
const guardTitle = "저장하지 않은 변경사항이 있습니다";
const ssoPath = "/admin/sso/keycloak/config";
const notificationPath = "/admin/notifications/mattermost";
const replacementSecret = "public-synthetic-inline-replacement";
const replacementWebhook = "https://notifications.example.invalid/hooks/public-synthetic-replacement";
type Kind = "sso" | "notification";
type Outcome = "saved" | "failed" | "reload_failed";
type Payload = Record<string, unknown>;
const user = {
  id: "inline-settings-admin",
  email: "inline-settings@example.invalid",
  name: "인라인 설정 운영자",
  role: "admin",
  roles: ["admin"],
  team_id: "public-fixture",
  scopes: ["admin:read", "admin:write"],
  features: { "system.settings": true },
};

function bootstrap(authenticated: boolean, canWrite: boolean): UiBootstrapResponse {
  const scopes = canWrite ? user.scopes : ["admin:read"];
  return {
    backend_version: "v0.86.6",
    ui_version: "inline-settings-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/system/settings?tab=sso",
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
    ...(authenticated ? { user: { ...user, scopes } } : {}),
    capabilities: { raw_prompt_view: false },
    roles: authenticated ? ["admin"] : [],
    permissions: authenticated ? scopes : [],
    allowed_features: authenticated ? ["system.settings"] : [],
    migration_registry: [
      {
        feature_id: "system.settings",
        title: "시스템 설정",
        app_path: "/app/system/settings",
        legacy_path: "/admin#/settings",
        status: "preview",
        risk_level: "critical",
        required_permission: "admin:read",
        read_only: false,
        enabled_roles: ["admin"],
        rollout_percent: 100,
        fallback_enabled: true,
        minimum_api_version: "v0.86.6",
        available: authenticated,
      },
    ],
    system_status: { status: "healthy" },
    legacy_route_map: { "/app/system/settings": "/admin#/settings" },
  };
}

async function installGateway(context: BrowserContext) {
  let sso: KeycloakConfig = {
    enabled: true,
    issuer_url: "https://identity.example.invalid/realms/public",
    client_id: "public-client-original",
    client_secret_set: true,
    redirect_uri: "https://gateway.example.invalid/auth/keycloak/callback",
    scopes: ["openid", "profile", "email"],
    default_role: "viewer",
    role_claim: "realm_access.roles",
    group_claim: "groups",
    allow_local_login: true,
    auto_login: false,
    role_map: { "public-operator": "admin" },
    source: "db",
    version: 3,
    updated_at: "2026-09-29T01:00:00Z",
  };
  let notification: NotificationConfig = {
    enabled: true,
    webhook_url: "********",
    webhook_url_set: true,
    channel: "public-original",
    events: ["cost"],
    available_events: ["cost", "secret", "approval", "provider"],
  };
  let storedSecret = "public-synthetic-original-secret";
  let storedWebhook = "https://notifications.example.invalid/hooks/public-synthetic-original";
  const sessions = new Map<string, string>();
  const unexpected: string[] = [];
  const writes: { kind: Kind; payload: Payload }[] = [];
  const tests: { kind: Kind; storedValue: string | undefined }[] = [];
  const reads: Record<Kind, number> = { sso: 0, notification: 0 };
  const responses: Record<Kind, number> = { sso: 0, notification: 0 };
  const outcomes: Record<Kind, Outcome[]> = { sso: [], notification: [] };
  const gates = new Map<string, Promise<void>>();
  const releases = new Map<string, () => void>();
  let canWrite = true;
  let loginCount = 0;
  let logoutCount = 0;
  let logoutResponseCount = 0;
  const hold = (key: string) => {
    gates.set(key, new Promise<void>((resolve) => releases.set(key, resolve)));
  };
  const release = (key: string) => {
    releases.get(key)?.();
    releases.delete(key);
    gates.delete(key);
  };
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const call = `${request.method()} ${url.pathname}`;
    const authorization = request.headers().authorization ?? "";
    const authenticated = sessions.has(authorization);
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "X-Request-ID": "req-inline-public-fixture" },
        body: JSON.stringify(body),
      });
    if (call === "POST /auth/login") {
      expect(request.postDataJSON()).toEqual({ email: user.email, password: "public-test-password" });
      loginCount += 1;
      const access = `public-inline-access-${loginCount}`;
      const refresh = `public-inline-refresh-${loginCount}`;
      sessions.set(`Bearer ${access}`, refresh);
      return json({
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_expires_in: 7200,
        user: { ...user, scopes: canWrite ? user.scopes : ["admin:read"] },
      });
    }
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap(authenticated, canWrite));
    if (call === "GET /health") return json({ status: "ok" });
    if (call === "GET /ready") return json({ status: "ready" });
    if (url.pathname.startsWith("/admin/") || url.pathname.startsWith("/auth/")) {
      if (!authenticated) {
        unexpected.push(`unauthorized ${call}`);
        return json({ error: { code: "unauthorized", message: "fixture authentication required" } }, 401);
      }
      if (call === "POST /auth/logout") {
        expect(request.postDataJSON()).toEqual({ refresh_token: sessions.get(authorization) });
        logoutCount += 1;
        sessions.clear();
        await gates.get("logout");
        await json({ ok: true });
        logoutResponseCount += 1;
        return;
      }
      if (call === "GET /admin/roles")
        return json({
          roles: [
            { role: "admin", scopes: ["admin:read", "admin:write"] },
            { role: "viewer", scopes: ["admin:read"] },
          ],
        });
      if (call === "GET /admin/mcp/oauth") return json({ enabled: false, active: false });
      if (call === "GET /admin/retention")
        return json({
          request_days: 30,
          prompt_days: 7,
          response_days: 7,
          requests: 0,
          prompts: 0,
          responses: 0,
        });
      if (call === "GET /admin/fallback")
        return json({ path: "public-fixture.ndjson", exists: false, bytes: 0, lines: 0 });
      if (call === "GET /admin/settings/effective")
        return json({ settings: [], this_pod: { up_to_date: true } });
      const kind =
        url.pathname === ssoPath ? "sso" : url.pathname === notificationPath ? "notification" : undefined;
      if (kind && request.method() === "GET") {
        reads[kind] += 1;
        await gates.get(`read-${kind}`);
        return json(kind === "sso" ? sso : notification);
      }
      if (kind && request.method() === (kind === "sso" ? "PUT" : "POST")) {
        if (!canWrite) {
          unexpected.push(`forbidden ${call}`);
          return json({ error: { message: "fixture requires admin:write" } }, 403);
        }
        expect(request.headers()["x-vibe-ui"]).toBe("app");
        expect(request.headers()["x-vibe-route"]).toBe("system.settings");
        const payload = request.postDataJSON() as Payload;
        writes.push({ kind, payload });
        if (kind === "sso") {
          expect(Object.keys(payload).sort()).toEqual(
            [
              "enabled",
              "issuer_url",
              "client_id",
              "redirect_uri",
              "scopes",
              "default_role",
              "role_claim",
              "group_claim",
              "allow_local_login",
              "auto_login",
              "role_map",
              "expected_version",
              ...(Object.hasOwn(payload, "client_secret") ? ["client_secret"] : []),
            ].sort(),
          );
          expect(Number.isSafeInteger(payload.expected_version)).toBe(true);
          if (payload.expected_version !== sso.version)
            return json({ error: { code: "sso_config_conflict", message: "fixture version conflict" } }, 409);
        } else {
          expect(Object.keys(payload).sort()).toEqual(
            [
              "enabled",
              "channel",
              "events",
              ...(Object.hasOwn(payload, "webhook_url") ? ["webhook_url"] : []),
            ].sort(),
          );
        }
        const outcome = outcomes[kind].shift() ?? "saved";
        if (outcome !== "failed") {
          // Commit before a held response. Logout cannot undo an already saved
          // server mutation; the late-response tests concern client isolation.
          if (kind === "sso") {
            if (Object.hasOwn(payload, "client_secret")) storedSecret = String(payload.client_secret);
            const { client_secret: _secret, expected_version: _version, ...publicFields } = payload;
            void _secret;
            void _version;
            sso = {
              ...sso,
              ...publicFields,
              version: (sso.version ?? 0) + 1,
              client_secret_set: storedSecret !== "",
            };
          } else {
            if (Object.hasOwn(payload, "webhook_url")) storedWebhook = String(payload.webhook_url);
            notification = {
              ...notification,
              enabled: payload.enabled as boolean,
              channel: payload.channel as string,
              events: payload.events as string[],
              webhook_url: storedWebhook ? "********" : "",
              webhook_url_set: storedWebhook !== "",
            };
          }
        }
        await gates.get(`save-${kind}`);
        if (outcome === "failed")
          return json({ error: { code: "fixture_unavailable", message: "fixture unavailable" } }, 503);
        if (outcome === "reload_failed") {
          expect(kind).toBe("sso");
          return json(
            { error: { code: "sso_reload_failed", message: "fixture persisted, reload failed" } },
            500,
          );
        }
        if (kind === "sso") await route.fulfill({ status: 204 });
        else await json(notification);
        responses[kind] += 1;
        return;
      }
      if (call === "POST /admin/sso/keycloak/test" || call === "POST /admin/notifications/mattermost/test") {
        if (!canWrite) {
          unexpected.push(`forbidden ${call}`);
          return json({ error: { message: "fixture requires admin:write" } }, 403);
        }
        expect(request.postData()).toBeNull();
        const testKind = url.pathname.includes("/sso/") ? "sso" : "notification";
        tests.push({
          kind: testKind,
          storedValue: testKind === "sso" ? sso.issuer_url : notification.channel,
        });
        return json(
          testKind === "sso" ? { ok: true, issuer: sso.issuer_url } : { status: "sent", webhook_status: 200 },
        );
      }
      unexpected.push(call);
      return json({ error: { message: "unexpected fixture API" } }, 501);
    }
    return route.continue();
  });
  return {
    unexpected,
    writes,
    tests,
    reads,
    responses,
    holdSave: (kind: Kind) => hold(`save-${kind}`),
    releaseSave: (kind: Kind) => release(`save-${kind}`),
    holdRead: (kind: Kind) => hold(`read-${kind}`),
    releaseRead: (kind: Kind) => release(`read-${kind}`),
    holdLogout: () => hold("logout"),
    releaseLogout: () => release("logout"),
    releaseAll: () => {
      for (const key of releases.keys()) release(key);
    },
    queue: (kind: Kind, ...next: Outcome[]) => outcomes[kind].push(...next),
    readOnly: () => {
      canWrite = false;
    },
    advance: (kind: Kind) => {
      if (kind === "sso") sso = { ...sso, client_id: "public-client-newer", version: (sso.version ?? 0) + 1 };
      else notification = { ...notification, channel: "public-channel-newer" };
    },
    storedSecret: () => storedSecret,
    storedWebhook: () => storedWebhook,
    logoutCount: () => logoutCount,
    logoutResponseCount: () => logoutResponseCount,
  };
}

type Gateway = Awaited<ReturnType<typeof installGateway>>;
const test = base.extend<{ api: Gateway }>({
  api: async ({ context }, run) => {
    const api = await installGateway(context);
    try {
      await run(api);
    } finally {
      api.releaseAll();
      expect(api.unexpected).toEqual([]);
    }
  },
});
const guard = (page: Page) => page.getByRole("alertdialog", { name: guardTitle });
const confirmSso = (page: Page) => page.getByRole("dialog", { name: "SSO 설정 저장", exact: true });
const draftField = (page: Page, kind: Kind) =>
  page.getByLabel(kind === "sso" ? "클라이언트 ID" : "채널", { exact: true });
const secretField = (page: Page, kind: Kind) =>
  page.getByLabel(kind === "sso" ? "클라이언트 비밀키" : "웹훅 주소", { exact: true });
const saveButton = (page: Page, kind: Kind) =>
  page.getByRole("button", { name: kind === "sso" ? "SSO 설정 저장" : "알림 설정 저장", exact: true });
const originalValue = (kind: Kind) => (kind === "sso" ? "public-client-original" : "public-original");
const newerValue = (kind: Kind) => (kind === "sso" ? "public-client-newer" : "public-channel-newer");

async function signIn(page: Page, kind: Kind) {
  await expect(page.getByRole("heading", { name: "관리자 로그인" })).toBeVisible();
  await page.getByLabel("이메일", { exact: true }).fill(user.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(draftField(page, kind)).toBeVisible();
}
async function open(page: Page, kind: Kind) {
  const target = `/app/system/settings?tab=${kind === "sso" ? "sso" : "operations"}`;
  await page.goto(`login?return_to=${encodeURIComponent(target)}`);
  await signIn(page, kind);
}
async function submit(page: Page, kind: Kind, sameTick = false) {
  await saveButton(page, kind).click();
  if (kind === "sso") {
    const button = confirmSso(page).getByRole("button", { name: "저장", exact: true });
    if (sameTick) await clickTwice(button);
    else await button.click();
  }
}
async function clickTwice(button: Locator) {
  // Same JavaScript task: a React render cannot hide a missing synchronous guard.
  await button.evaluate((element) => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
}
async function refresh(page: Page, api: Gateway, kind: Kind) {
  const previous = api.reads[kind];
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect.poll(() => api.reads[kind]).toBeGreaterThan(previous);
}
async function noStoredDraft(page: Page) {
  const storage = await page.evaluate(() =>
    [...Object.values(localStorage), ...Object.values(sessionStorage)].join("\n"),
  );
  for (const value of [replacementSecret, replacementWebhook, "public-inline-draft"])
    expect(storage).not.toContain(value);
}

for (const kind of ["sso", "notification"] as const) {
  test(`${kind} 인라인 변경 취소는 Escape로 계속 편집하고 명시적 폐기와 원복은 안전하게 초기화한다`, async ({
    page,
    api,
  }, testInfo) => {
    await open(page, kind);
    await draftField(page, kind).fill("public-inline-draft");
    await secretField(page, kind).fill(kind === "sso" ? replacementSecret : replacementWebhook);
    await page.screenshot({ path: testInfo.outputPath(`inline-${kind}-desktop.png`), fullPage: true });
    await draftField(page, kind).focus();
    await page.getByRole("button", { name: "변경 취소", exact: true }).click();
    await expect(guard(page).getByRole("button", { name: "계속 편집" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(guard(page)).toBeHidden();
    await expect(draftField(page, kind)).toHaveValue("public-inline-draft");
    await expect(page.getByRole("button", { name: "변경 취소", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "변경 취소", exact: true }).click();
    await guard(page).getByRole("button", { name: "변경 버리기" }).click();
    await expect(draftField(page, kind)).toHaveValue(originalValue(kind));
    await expect(secretField(page, kind)).toHaveValue("");
    await draftField(page, kind).fill("public-inline-draft");
    await draftField(page, kind).fill(originalValue(kind));
    await page.getByRole("button", { name: "변경 취소", exact: true }).click();
    await expect(guard(page)).toBeHidden();
    await noStoredDraft(page);
    expect(api.writes).toHaveLength(0);
  });

  test(`${kind} 실제 조회 갱신은 깨끗한 폼만 갱신하고 초안과 비밀 입력을 재마운트하지 않는다`, async ({
    page,
    api,
  }) => {
    await open(page, kind);
    api.advance(kind);
    await refresh(page, api, kind);
    await expect(draftField(page, kind)).toHaveValue(newerValue(kind));
    await draftField(page, kind).fill("public-inline-draft");
    await secretField(page, kind).fill(kind === "sso" ? replacementSecret : replacementWebhook);
    api.advance(kind);
    await refresh(page, api, kind);
    await expect(draftField(page, kind)).toHaveValue("public-inline-draft");
    await expect(secretField(page, kind)).toHaveValue(
      kind === "sso" ? replacementSecret : replacementWebhook,
    );
    await page.getByRole("button", { name: "변경 취소", exact: true }).click();
    await guard(page).getByRole("button", { name: "변경 버리기" }).click();
    await expect(draftField(page, kind)).toHaveValue(newerValue(kind));
    await expect(secretField(page, kind)).toHaveValue("");
    expect(api.writes).toHaveLength(0);
  });

  test(`${kind} 비밀 설정의 빈 입력 유지·교체·명시적 삭제는 서로 다른 한 번의 저장이며 성공 후 지워진다`, async ({
    page,
    api,
  }) => {
    await open(page, kind);
    const stored = kind === "sso" ? api.storedSecret : api.storedWebhook;
    const initial = stored();
    const key = kind === "sso" ? "client_secret" : "webhook_url";
    await expect(secretField(page, kind)).toHaveValue("");
    await draftField(page, kind).fill("public-inline-draft");
    await submit(page, kind);
    await expect(
      page.getByText(kind === "sso" ? "SSO 설정을 저장했습니다." : "알림 설정을 저장했습니다.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(api.writes).toHaveLength(1);
    expect(api.writes[0]?.payload).not.toHaveProperty(key);
    expect(stored()).toBe(initial);
    await secretField(page, kind).fill(kind === "sso" ? replacementSecret : replacementWebhook);
    await submit(page, kind);
    await expect(secretField(page, kind)).toHaveValue("");
    expect(api.writes).toHaveLength(2);
    expect(stored()).toBe(kind === "sso" ? replacementSecret : replacementWebhook);
    expect(api.writes[1]?.payload[key]).toBe(stored());
    await page
      .getByRole("checkbox", {
        name: kind === "sso" ? "저장된 클라이언트 비밀키 지우기" : "저장된 웹훅 주소 지우기",
        exact: true,
      })
      .check();
    await expect(secretField(page, kind)).toBeDisabled();
    await submit(page, kind);
    await expect(secretField(page, kind)).toBeEnabled();
    await expect(secretField(page, kind)).toHaveValue("");
    expect(api.writes).toHaveLength(3);
    expect(api.writes[2]?.payload[key]).toBe("");
    expect(stored()).toBe("");
    await noStoredDraft(page);
  });

  test(`${kind} 저장 실패는 초안을 보존하고 입력을 다시 허용하며 명시적 재시도 성공만 비밀값을 지운다`, async ({
    page,
    api,
  }) => {
    await open(page, kind);
    api.queue(kind, "failed", "saved");
    await draftField(page, kind).fill("public-inline-draft");
    await secretField(page, kind).fill(kind === "sso" ? replacementSecret : replacementWebhook);
    await submit(page, kind);
    await expect(page.getByRole("alert")).toContainText("서버가 요청을 처리하지 못했습니다");
    expect(api.writes).toHaveLength(1);
    if (kind === "sso") await page.keyboard.press("Escape");
    await expect(draftField(page, kind)).toBeEnabled();
    await expect(draftField(page, kind)).toHaveValue("public-inline-draft");
    await expect(secretField(page, kind)).toHaveValue(
      kind === "sso" ? replacementSecret : replacementWebhook,
    );
    await submit(page, kind);
    await expect(secretField(page, kind)).toHaveValue("");
    expect(api.writes).toHaveLength(2);
  });

  test(`${kind} 실제 탭 이동과 새로고침은 초안을 보호하고 폐기한 이동은 새 본문에 포커스한다`, async ({
    page,
    api,
  }) => {
    await open(page, kind);
    await page.getByRole("tab", { name: "런타임 설정", exact: true }).click();
    await page
      .getByRole("tab", { name: kind === "sso" ? "SSO (Keycloak)" : "데이터·알림 운영", exact: true })
      .click();
    await draftField(page, kind).fill("public-inline-draft");
    const nativeDialog = page.waitForEvent("dialog");
    await page.evaluate(() => {
      setTimeout(() => window.location.reload(), 0);
    });
    const dialog = await nativeDialog;
    expect(dialog.type()).toBe("beforeunload");
    await dialog.dismiss();
    await expect(draftField(page, kind)).toHaveValue("public-inline-draft");
    // Tab state intentionally replaces history; use the visible route action
    // instead of inventing an in-app Back entry. Shared Back coverage is separate.
    await page.getByRole("tab", { name: "런타임 설정", exact: true }).click();
    await expect(guard(page)).toBeVisible();
    await guard(page).getByRole("button", { name: "계속 편집" }).click();
    await expect(draftField(page, kind)).toHaveValue("public-inline-draft");
    await page.getByRole("tab", { name: "런타임 설정", exact: true }).click();
    await guard(page).getByRole("button", { name: "변경 버리기" }).click();
    await expect(draftField(page, kind)).toBeHidden();
    await expect(page.locator("#main-content")).toBeFocused();
    expect(api.writes).toHaveLength(0);
  });

  test(`${kind} 테스트 액션은 저장된 설정만 사용하고 편집한 초안이나 비밀값을 전송하지 않는다`, async ({
    page,
    api,
  }) => {
    await open(page, kind);
    await draftField(page, kind).fill("public-inline-draft");
    if (kind === "sso")
      await page
        .getByLabel("발급자 주소 (Issuer URL)", { exact: true })
        .fill("https://unsaved.example.invalid/realms/public");
    await secretField(page, kind).fill(kind === "sso" ? replacementSecret : replacementWebhook);
    await expect(
      page.getByText(
        kind === "sso"
          ? /연결 테스트는 저장 후 이 파드에 적용된 설정을 사용하며 초안을 저장하지 않습니다/u
          : /테스트 메시지는 저장된 설정을 사용하며 초안을 저장하지 않습니다/u,
      ),
    ).toBeVisible();
    await page
      .getByRole("button", { name: kind === "sso" ? "연결 테스트" : "테스트 메시지 발송", exact: true })
      .click();
    await expect.poll(() => api.tests.length).toBe(1);
    expect(api.tests[0]).toEqual({
      kind,
      storedValue: kind === "sso" ? "https://identity.example.invalid/realms/public" : "public-original",
    });
    expect(api.writes).toHaveLength(0);
    await expect(draftField(page, kind)).toHaveValue("public-inline-draft");
    await expect(secretField(page, kind)).toHaveValue(
      kind === "sso" ? replacementSecret : replacementWebhook,
    );
  });

  test(`${kind} 보류된 저장 응답은 교차 탭 로그아웃과 재로그인 이후 새 초안·토스트를 바꾸지 않는다`, async ({
    page,
    context,
    api,
  }) => {
    await open(page, kind);
    const other = await context.newPage();
    await open(other, kind);
    await draftField(page, kind).fill("public-inline-draft");
    api.holdSave(kind);
    await submit(page, kind);
    await expect.poll(() => api.writes.length).toBe(1);
    api.holdLogout();
    await other.getByLabel("사용자 메뉴").click();
    await other.getByRole("button", { name: "로그아웃", exact: true }).click();
    for (const tab of [page, other]) {
      await expect(tab.getByRole("heading", { name: "관리자 로그인" })).toBeVisible();
      await expect(draftField(tab, kind)).toBeHidden();
      await expect(guard(tab)).toBeHidden();
    }
    expect(api.logoutResponseCount()).toBe(0);
    await signIn(page, kind);
    // The server did commit the earlier request; only this new client draft is protected.
    await draftField(page, kind).fill("public-fresh-session-draft");
    const readCount = api.reads[kind];
    const response = page.waitForResponse(
      (result) =>
        new URL(result.url()).pathname === (kind === "sso" ? ssoPath : notificationPath) &&
        result.request().method() === (kind === "sso" ? "PUT" : "POST"),
    );
    api.releaseSave(kind);
    // A stale-session 204 is rejected before body consumption. Chromium can
    // leave response.finished pending; observe delivery and real UI interaction.
    expect((await response).status()).toBe(kind === "sso" ? 204 : 200);
    await expect.poll(() => api.responses[kind]).toBe(1);
    await page.getByRole("button", { name: "변경 취소", exact: true }).click();
    await expect(guard(page)).toBeVisible();
    await guard(page).getByRole("button", { name: "계속 편집" }).click();
    await expect(draftField(page, kind)).toHaveValue("public-fresh-session-draft");
    await expect(
      page.getByText(kind === "sso" ? "SSO 설정을 저장했습니다." : "알림 설정을 저장했습니다.", {
        exact: true,
      }),
    ).toBeHidden();
    expect(api.reads[kind]).toBe(readCount);
    api.releaseLogout();
    await expect.poll(api.logoutResponseCount).toBe(1);
    await expect(draftField(page, kind)).toHaveValue("public-fresh-session-draft");
    expect(api.writes).toHaveLength(1);
    expect(api.logoutCount()).toBe(1);
    await noStoredDraft(page);
  });
}

test("SSO 확인 중 도착한 새 조회도 검토한 버전을 바꾸지 않으며 409는 초안과 재전송 잠금을 유지한다", async ({
  page,
  api,
}) => {
  await open(page, "sso");
  api.holdRead("sso");
  await refresh(page, api, "sso");
  await saveButton(page, "sso").click();
  api.advance("sso");
  api.releaseRead("sso");
  await expect(page.getByText("서버의 SSO 설정이 변경되었습니다.", { exact: true })).toBeVisible();
  await expect(draftField(page, "sso")).toHaveValue("public-client-original");
  await confirmSso(page).getByRole("button", { name: "저장", exact: true }).click();
  await expect(confirmSso(page).getByRole("alert")).toContainText("초안을 보존했습니다");
  expect(api.writes).toHaveLength(1);
  expect(api.writes[0]?.payload).toMatchObject({ expected_version: 3, client_id: "public-client-original" });
  await expect(confirmSso(page).getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(saveButton(page, "sso")).toBeDisabled();
  await page.getByRole("button", { name: "최신 설정 다시 불러오기", exact: true }).click();
  await expect(draftField(page, "sso")).toHaveValue("public-client-newer");
  await expect(saveButton(page, "sso")).toBeEnabled();
  expect(api.writes).toHaveLength(1);
});

test("SSO 같은 틱 이중 확인은 한 요청만 보내고 pending 동안 입력·확인 취소를 잠근다", async ({
  page,
  api,
}) => {
  await open(page, "sso");
  await draftField(page, "sso").fill("public-inline-draft");
  api.holdSave("sso");
  await submit(page, "sso", true);
  await expect.poll(() => api.writes.length).toBe(1);
  const payload = structuredClone(api.writes[0]?.payload);
  expect(payload).toMatchObject({ expected_version: 3, client_id: "public-inline-draft" });
  for (const label of ["클라이언트 ID", "클라이언트 비밀키", "기본 역할"])
    await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
  // The confirmation correctly hides the underlying form from the a11y tree.
  await expect(
    page.getByRole("switch", { name: "SSO 사용", exact: true, includeHidden: true }),
  ).toBeDisabled();
  await expect(confirmSso(page).getByRole("button", { name: "취소", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(confirmSso(page)).toBeVisible();
  api.releaseSave("sso");
  await expect(confirmSso(page)).toBeHidden();
  await expect(draftField(page, "sso")).toBeEnabled();
  expect(api.writes).toEqual([{ kind: "sso", payload }]);
});

test("SSO 초안 중 새 조회를 받아도 저장은 이전 CAS 버전으로 충돌하고 폐기 후에만 최신 값을 검토한다", async ({
  page,
  api,
}) => {
  await open(page, "sso");
  await draftField(page, "sso").fill("public-inline-draft");
  await secretField(page, "sso").fill(replacementSecret);
  api.advance("sso");
  await refresh(page, api, "sso");
  await expect(draftField(page, "sso")).toHaveValue("public-inline-draft");
  await submit(page, "sso");
  await expect(confirmSso(page).getByRole("alert")).toContainText("초안을 보존했습니다");
  await expect(confirmSso(page).getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  expect(api.writes).toHaveLength(1);
  expect(api.writes[0]?.payload).toMatchObject({
    expected_version: 3,
    client_id: "public-inline-draft",
    client_secret: replacementSecret,
  });
  await page.keyboard.press("Escape");
  await expect(secretField(page, "sso")).toHaveValue(replacementSecret);
  await page.getByRole("button", { name: "최신 설정 다시 불러오기", exact: true }).click();
  await expect(guard(page)).toBeVisible();
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  await expect(draftField(page, "sso")).toHaveValue("public-inline-draft");
  await page.getByRole("button", { name: "최신 설정 다시 불러오기", exact: true }).click();
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  await expect(draftField(page, "sso")).toHaveValue("public-client-newer");
  await expect(secretField(page, "sso")).toHaveValue("");
  await expect(saveButton(page, "sso")).toBeEnabled();
  expect(api.writes).toHaveLength(1);
});

test("알림 같은 틱 이중 저장은 한 원본 요청만 보내고 pending 경로 폐기를 허용하지 않는다", async ({
  page,
  api,
}) => {
  await open(page, "notification");
  await draftField(page, "notification").fill("public-inline-draft");
  api.holdSave("notification");
  await clickTwice(saveButton(page, "notification"));
  await expect.poll(() => api.writes.length).toBe(1);
  for (const label of ["채널", "웹훅 주소", "비용 경보"])
    await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
  await expect(page.getByRole("switch", { name: "알림 사용", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "변경 취소", exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: "런타임 설정", exact: true }).click();
  await expect(guard(page)).toBeVisible();
  await expect(guard(page).getByRole("button", { name: "변경 버리기" })).toBeDisabled();
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  api.releaseSave("notification");
  await expect(draftField(page, "notification")).toBeEnabled();
  await expect(draftField(page, "notification")).toHaveValue("public-inline-draft");
  expect(api.writes).toEqual([
    { kind: "notification", payload: { enabled: true, channel: "public-inline-draft", events: ["cost"] } },
  ]);
});

test("SSO 저장된 500 재적재 실패는 비밀 입력을 지우고 재저장을 차단한다", async ({ page, api }) => {
  await open(page, "sso");
  api.queue("sso", "reload_failed");
  await draftField(page, "sso").fill("public-inline-draft");
  await secretField(page, "sso").fill(replacementSecret);
  await submit(page, "sso");
  await expect(confirmSso(page)).toBeHidden();
  await expect(page.getByText(/설정은 저장되었지만 런타임 재적재에 실패했습니다/u)).toBeVisible();
  await expect(secretField(page, "sso")).toHaveValue("");
  await expect(saveButton(page, "sso")).toBeDisabled();
  expect(api.storedSecret()).toBe(replacementSecret);
  expect(api.writes).toHaveLength(1);
  await refresh(page, api, "sso");
  await expect(saveButton(page, "sso")).toBeDisabled();
  await page.getByRole("tab", { name: "런타임 설정", exact: true }).click();
  await page.getByRole("tab", { name: "SSO (Keycloak)", exact: true }).click();
  await expect(page.getByText(/설정은 저장되었지만 런타임 재적재에 실패했습니다/u)).toBeVisible();
  await expect(secretField(page, "sso")).toHaveValue("");
  await page.getByRole("button", { name: "최신 설정 다시 불러오기", exact: true }).click();
  await expect(draftField(page, "sso")).toBeEnabled();
  await expect(saveButton(page, "sso")).toBeDisabled();
  await expect(
    page.getByText(/실제 로그인 적용이나 모든 파드의 활성 상태를 증명하지 않습니다/u),
  ).toBeVisible();
  await draftField(page, "sso").fill("public-new-deliberate-change");
  await expect(saveButton(page, "sso")).toBeEnabled();
  expect(api.writes).toHaveLength(1);
  await noStoredDraft(page);
});

test("알림 마스킹값·공백은 서버로 전송하지 않고 읽기 전용 권한은 두 폼 쓰기를 막는다", async ({
  page,
  context,
  api,
}) => {
  await open(page, "notification");
  for (const invalid of ["********", "   "]) {
    await secretField(page, "notification").fill(invalid);
    await saveButton(page, "notification").click();
    await expect(page.getByRole("alert")).toContainText("마스킹된 주소나 공백만 저장할 수 없습니다");
  }
  expect(api.writes).toHaveLength(0);
  api.readOnly();
  const other = await context.newPage();
  await open(other, "sso");
  for (const label of ["클라이언트 ID", "클라이언트 비밀키"])
    await expect(other.getByLabel(label, { exact: true })).toBeDisabled();
  await expect(other.getByRole("switch", { name: "SSO 사용", exact: true })).toBeDisabled();
  await expect(saveButton(other, "sso")).toBeDisabled();
  await other.getByRole("tab", { name: "데이터·알림 운영", exact: true }).click();
  await expect(draftField(other, "notification")).toBeDisabled();
  await expect(saveButton(other, "notification")).toBeDisabled();
  expect(api.writes).toHaveLength(0);
});

test("390px 다크 인라인 폐기 확인은 axe·가로 넘침 없이 키보드로 편집을 계속한다", async ({
  page,
  api,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await open(page, "notification");
  await draftField(page, "notification").fill("public-inline-draft");
  await page.getByRole("button", { name: "변경 취소", exact: true }).click();
  await expect(guard(page).getByRole("button", { name: "계속 편집" })).toBeFocused();
  await expect(guard(page).getByRole("button", { name: "변경 버리기" })).toBeInViewport();
  expect(
    await page.evaluate(
      () => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) <= window.innerWidth,
    ),
  ).toBe(true);
  const violations = await page.evaluate(async () => {
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
  await page.screenshot({ path: testInfo.outputPath("inline-settings-mobile-dark.png"), fullPage: false });
  expect(violations).toEqual([]);
  await page.keyboard.press("Tab");
  await expect(guard(page).getByRole("button", { name: "변경 버리기" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(guard(page)).toBeHidden();
  await expect(draftField(page, "notification")).toHaveValue("public-inline-draft");
  expect(api.writes).toHaveLength(0);
});
