import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// Browser-only public fixtures, not evidence of real Go authorization. The
// separate Go contract tests own server scope/ownership and persistence proof.
export const targetUrl = "/app/me?tab=keys";
export const extension = "fixture:personal:retained-permission-with-a-long-public-identifier";
export const known = ["chat:completion", "embeddings:create", "models:read"];
export const firstEmail = "personal-one@example.invalid";
export const secondEmail = "personal-two@example.invalid";

export interface PersonalKey {
  id: string;
  name: string;
  user_id: string;
  role: string;
  status: string;
  scopes: string[];
}
export const alpha: PersonalKey = {
  id: "personal-alpha",
  name: "개인 노트북 키",
  user_id: "personal-one",
  role: "developer",
  status: "active",
  scopes: ["models:read", extension],
};
export const beta: PersonalKey = {
  ...alpha,
  id: "personal-beta",
  name: "개인 데스크톱 키",
  scopes: ["models:read"],
};
export const empty: PersonalKey = { ...alpha, id: "personal-empty", name: "권한 없는 개인 키", scopes: [] };
export const second: PersonalKey = {
  ...beta,
  id: "personal-second",
  name: "두 번째 계정 키",
  user_id: "personal-two",
};

const userFor = (email: string) => ({
  id: email === secondEmail ? "personal-two" : "personal-one",
  email,
  name: "개인 권한 사용자",
  role: "developer",
  roles: ["developer"],
  team_id: "personal-fixture-team",
  scopes: [...known],
  features: { "me.home": true },
});
type User = ReturnType<typeof userFor>;

function bootstrap(user?: User): UiBootstrapResponse {
  return {
    backend_version: "v0.86.12",
    ui_version: "personal-scope-fixture",
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
      authenticated: Boolean(user),
      mode: "session",
      keycloak_enabled: false,
      allow_local_login: true,
      sso_login_url: "/auth/keycloak/login",
    },
    ...(user ? { user } : {}),
    capabilities: { raw_prompt_view: false },
    roles: user?.roles ?? [],
    permissions: user?.scopes ?? [],
    allowed_features: user ? ["me.home"] : [],
    migration_registry: [
      {
        feature_id: "me.home",
        title: "내 홈",
        app_path: "/app/me",
        legacy_path: "/admin#/me",
        status: "preview",
        risk_level: "low",
        required_permission: "",
        read_only: false,
        enabled_roles: [],
        rollout_percent: 100,
        fallback_enabled: true,
        minimum_api_version: "v0.84.0",
        available: Boolean(user),
      },
    ],
    system_status: { status: "healthy" },
    legacy_route_map: { "/app/me": "/admin#/me" },
  };
}

async function installGateway(context: BrowserContext) {
  const sessions = new Map<string, { refresh: string; user: User }>();
  let keys = structuredClone([
    alpha,
    beta,
    empty,
    { ...beta, id: "personal-revoked", name: "폐기된 개인 키", status: "revoked" },
    second,
  ]);
  let catalog: unknown = [...known, extension];
  let reads = 0;
  let readStatus = 200;
  let saveStatus = 200;
  let logins = 0;
  let logouts = 0;
  let logoutResponses = 0;
  let readGate: Promise<void> | undefined;
  let releaseRead: (() => void) | undefined;
  let saveGate: Promise<void> | undefined;
  let releaseSave: (() => void) | undefined;
  let logoutGate: Promise<void> | undefined;
  let releaseLogout: (() => void) | undefined;
  const unexpected: string[] = [];
  const adminCalls: string[] = [];
  const saves: { id: string; body: { scopes: string[] }; userId: string }[] = [];

  await context.route("**/*", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const call = `${request.method()} ${path}`;
    const authorization = request.headers().authorization ?? "";
    const session = sessions.get(authorization);
    const json = (body: unknown, status = 200, requestId = "req-personal-scope") =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "X-Request-ID": requestId },
        body: JSON.stringify(body),
      });
    if (call === "POST /auth/login") {
      const body: { email: string; password: string } = request.postDataJSON();
      expect([firstEmail, secondEmail]).toContain(body.email);
      expect(body.password).toBe("public-test-password");
      logins += 1;
      const user = userFor(body.email);
      const access = `public-personal-access-${logins}`;
      const refresh = `public-personal-refresh-${logins}`;
      sessions.set(`Bearer ${access}`, { refresh, user });
      return json({
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_expires_in: 7200,
        user,
      });
    }
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap(session?.user));
    if (call === "GET /health") return json({ status: "ok" });
    if (call === "GET /ready") return json({ status: "ready" });
    if (path.startsWith("/admin/")) {
      adminCalls.push(call);
      return json({ error: { message: "Personal fixtures have no admin permission" } }, 403);
    }
    if (path.startsWith("/auth/") || path.startsWith("/me/")) {
      if (!session) {
        unexpected.push(`unauthenticated ${call}`);
        return json({ error: { message: "Fixture login required" } }, 401);
      }
      if (call === "POST /auth/logout") {
        expect(request.postDataJSON()).toEqual({ refresh_token: session.refresh });
        sessions.delete(authorization);
        logouts += 1;
        if (logoutGate) await logoutGate;
        await json({ ok: true });
        logoutResponses += 1;
        return;
      }
      if (call === "GET /me/keys") {
        reads += 1;
        const snapshot = {
          api_keys: structuredClone(keys.filter((key) => key.user_id === session.user.id)),
          role: "developer",
          ...(catalog === undefined ? {} : { grantable_scopes: structuredClone(catalog) }),
        };
        const status = readStatus;
        if (readGate) await readGate;
        return status === 200
          ? json(snapshot, 200, "req-personal-catalog")
          : json({ error: { message: "Personal catalog unavailable" } }, status, "req-personal-catalog");
      }
      if (call === "GET /me/sessions") return json({ sessions: [] });
      if (call === "GET /me/requests") return json({ requests: [] });
      if (call === "GET /me/recommended-models")
        return json({ task_recommendations: [], your_models: [], team_winners: [] });
      if (call === "GET /me/dashboard") return json({ user_id: session.user.id });
      if (call === "GET /me/actions") return json({ user_id: session.user.id, actions: [], count: 0 });
      if (call === "GET /me/report") return json({ user_id: session.user.id, window: "weekly" });
      if (call === "GET /me/notifications")
        return json({ user_id: session.user.id, notifications: [], count: 0, critical_count: 0 });
      const id = path.match(/^\/me\/keys\/([^/]+)$/u)?.[1];
      if (request.method() === "PATCH" && id) {
        const body = request.postDataJSON() as { scopes: string[] };
        expect(keys.some((key) => key.id === id && key.user_id === session.user.id)).toBe(true);
        expect(Object.keys(body)).toEqual(["scopes"]);
        expect(Array.isArray(body.scopes)).toBe(true);
        const snapshot = structuredClone({ id, body, userId: session.user.id });
        saves.push(snapshot);
        const status = saveStatus;
        if (saveGate) await saveGate;
        if (status !== 200)
          return json({ error: { message: "Personal scope save failed" } }, status, "req-personal-save");
        keys = keys.map((key) => (key.id === id ? { ...key, scopes: [...snapshot.body.scopes] } : key));
        return json({ id, scopes: snapshot.body.scopes });
      }
      unexpected.push(call);
      return json({ error: { message: "Unexpected personal fixture request" } }, 501);
    }
    return route.continue();
  });
  return {
    unexpected,
    adminCalls,
    saves,
    reads: () => reads,
    logouts: () => logouts,
    logoutResponses: () => logoutResponses,
    replaceKeys: (next: PersonalKey[]) => {
      keys = structuredClone(next);
    },
    replaceCatalog: (next: unknown) => {
      catalog = structuredClone(next);
    },
    failReads: () => {
      readStatus = 503;
    },
    succeedReads: () => {
      readStatus = 200;
    },
    holdReads: () => {
      readGate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
    },
    releaseReads: () => {
      releaseRead?.();
      readGate = undefined;
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
    releaseSaves: () => {
      releaseSave?.();
      saveGate = undefined;
    },
    holdLogouts: () => {
      logoutGate = new Promise<void>((resolve) => {
        releaseLogout = resolve;
      });
    },
    releaseLogouts: () => {
      releaseLogout?.();
      logoutGate = undefined;
    },
  };
}

type Gateway = Awaited<ReturnType<typeof installGateway>>;
export const test = base.extend<{ gateway: Gateway }>({
  gateway: async ({ context }, run) => {
    const gateway = await installGateway(context);
    try {
      await run(gateway);
    } finally {
      gateway.releaseReads();
      gateway.releaseSaves();
      gateway.releaseLogouts();
      expect(gateway.unexpected).toEqual([]);
      expect(gateway.adminCalls).toEqual([]);
    }
  },
});
