import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { RoutingRule } from "../../src/shared/api/domains/routing";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// Synthetic HTTP only: this fixture does not establish Go RBAC, CAS, audit,
// multi-pod propagation, upstream execution or server-side cancellation.
export const routingUrl = "/app/routing/rules";
export const listPath = "/admin/routing-rules";
export const firstEmail = "routing-one@example.invalid";
export const secondEmail = "routing-two@example.invalid";
export const ruleA = "route_public_a";
export const ruleB = "route_public_b";
export const requestId = "req-routing-toggle-review";
export const readonlyReason = "이 화면은 읽기 전용입니다. 변경 저장과 실제 외부 실행을 할 수 없습니다.";
export const timestamp = "2026-09-30T01:00:00Z";
export const rule = (id = ruleA, enabled = true): RoutingRule => ({
  id,
  enabled,
  priority: id === ruleB ? 20 : 10,
  match_pattern: id === ruleB ? "public-b-*" : "public-a-*",
  min_complexity: 0,
  max_complexity: 40,
  target_model: id === ruleB ? "public-model-b" : "public-model-a",
  target_provider: "public-provider",
  note: "공개 합성 규칙 메모",
  created_at: timestamp,
});
export type Mode = "writable" | "read_only" | "preview_read_only";
export type Action = "list" | "patch";
type Operation = {
  action: Action;
  path: string;
  id?: string;
  body: Record<string, unknown> | null;
  userId: string;
};
const userFor = (email: string, read: boolean, write: boolean) => ({
  id: email === secondEmail ? "routing-two" : "routing-one",
  email,
  name: "합성 라우팅 운영자",
  role: "admin",
  roles: ["admin"],
  team_id: "public-team",
  // No admin:write or raw-prompt-view elevation: routing scopes are sufficient.
  scopes: [...(read ? ["routing:read"] : []), ...(write ? ["routing:write"] : [])],
  features: { "routing.rules": true },
});
type User = ReturnType<typeof userFor>;
function bootstrap(user: User | undefined, mode: Mode, prefixes: string[]): UiBootstrapResponse {
  return {
    backend_version: "v0.86.25",
    ui_version: "routing-toggle-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: routingUrl,
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
      credential_prefixes: prefixes,
    },
    ...(user ? { user } : {}),
    roles: user?.roles ?? [],
    permissions: user?.scopes ?? [],
    allowed_features: user ? ["routing.rules"] : [],
    capabilities: { raw_prompt_view: false },
    migration_registry: [
      {
        feature_id: "routing.rules",
        title: "라우팅 규칙",
        app_path: routingUrl,
        legacy_path: "/admin#/routing",
        status: mode === "preview_read_only" ? "preview_read_only" : "preview",
        read_only: mode === "read_only",
        risk_level: "high",
        required_permission: "routing:read",
        enabled_roles: [],
        rollout_percent: 100,
        fallback_enabled: true,
        minimum_api_version: "v0.83.0",
        available: Boolean(user?.scopes.includes("routing:read")),
      },
    ],
    system_status: { status: "healthy" },
    legacy_route_map: { [routingUrl]: "/admin#/routing" },
  };
}
async function install(context: BrowserContext) {
  let mode: Mode = "writable",
    read = true,
    write = true,
    logins = 0;
  let rows = [rule(), rule(ruleB)];
  let prefixes = ["vc_sk_", "vc_sa_"];
  const sessions = new Map<string, User>();
  const operations: Operation[] = [],
    finished: Action[] = [],
    unexpected: string[] = [];
  const statuses = new Map<Action, number>();
  const gates = new Map<Action, Promise<void>>(),
    releases = new Map<Action, () => void>();
  const release = (action: Action) => {
    releases.get(action)?.();
    releases.delete(action);
    gates.delete(action);
  };
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const method = request.method(),
      call = `${method} ${path}`;
    const session = sessions.get(request.headers().authorization ?? "");
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "X-Request-ID": requestId },
        body: JSON.stringify(body),
      });
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      unexpected.push(`external ${call}`);
      return json({ error: { message: "Synthetic fixture forbids external requests" } }, 501);
    }
    if (call === "POST /auth/login") {
      const body = request.postDataJSON() as { email: string; password: string };
      expect([firstEmail, secondEmail]).toContain(body.email);
      expect(body.password).toBe("public-test-password");
      const user = userFor(body.email, read, write),
        access = `public-routing-access-${++logins}`;
      sessions.set(`Bearer ${access}`, user);
      return json({
        access_token: access,
        refresh_token: `public-routing-refresh-${logins}`,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_expires_in: 7200,
        user,
      });
    }
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap(session, mode, prefixes));
    if (call === "GET /auth/me")
      return json({
        version: "v0.86.25",
        auth_enabled: true,
        credential_prefixes: prefixes,
        ...(session ? { user: session } : {}),
      });
    if (call === "GET /auth/sso/status")
      return json({
        keycloak_enabled: false,
        allow_local_login: true,
        login_url: "/auth/keycloak/login",
      });
    if (call === "GET /health" || call === "GET /ready")
      return json({ status: path === "/health" ? "ok" : "ready" });
    if (path.startsWith("/v1/") || path.startsWith("/mcp")) {
      unexpected.push(`runtime ${call}`);
      return json({ error: { message: "No model execution in routing toggle tests" } }, 501);
    }
    if (!path.startsWith("/admin/") && !path.startsWith("/auth/")) return route.continue();
    if (!session) {
      unexpected.push(`unauthenticated ${call}`);
      return json({ error: { message: "Synthetic session required" } }, 401);
    }
    if (call === "POST /auth/logout") {
      sessions.delete(request.headers().authorization ?? "");
      return json({ status: "logged_out" });
    }
    const action: Action | undefined =
      path === listPath && method === "GET"
        ? "list"
        : path.startsWith(`${listPath}/`) && method === "PATCH"
          ? "patch"
          : undefined;
    if (!action) {
      unexpected.push(call);
      return json({ error: { message: "Unexpected synthetic request" } }, 501);
    }
    const id = action === "patch" ? decodeURIComponent(path.slice(listPath.length + 1)) : undefined;
    const body = action === "patch" ? (request.postDataJSON() as Record<string, unknown>) : null;
    // Every attempt is recorded before status/body handling. The fixture never
    // enforces feature readonly or scopes on behalf of the UI under test.
    operations.push({ action, path, id, body: structuredClone(body), userId: session.id });
    expect(request.headers()["x-vibe-ui"]).toBe("app");
    let status = statuses.get(action) ?? 200;
    let response: unknown = { rules: structuredClone(rows) };
    if (action === "patch" && status === 200) {
      expect(Object.keys(body ?? {})).toEqual(["enabled"]);
      expect(typeof body?.enabled).toBe("boolean");
      const index = rows.findIndex((item) => item.id === id);
      const current = rows[index];
      if (!current) status = 404;
      else {
        rows[index] = { ...current, enabled: body?.enabled as boolean };
        response = { rule: structuredClone(rows[index]) };
      }
    }
    // Commit/snapshot precedes held fulfillment. A browser abort does not imply
    // rollback, and this does not simulate progressive or actual Go responses.
    await gates.get(action);
    try {
      return await json(
        status === 200
          ? response
          : {
              error: {
                message: "Synthetic routing operation unavailable",
                type: "server_error",
                code: "synthetic_failure",
              },
            },
        status,
      );
    } finally {
      finished.push(action);
    }
  });
  const updateScopes = () => {
    for (const user of sessions.values()) user.scopes = userFor(user.email, read, write).scopes;
  };
  return {
    operations,
    finished,
    unexpected,
    count: (action: Action) => operations.filter((item) => item.action === action).length,
    records: () => structuredClone(rows),
    setRows: (next: RoutingRule[]) => {
      rows = structuredClone(next);
    },
    setMode: (next: Mode) => {
      mode = next;
    },
    setWrite: (next: boolean) => {
      write = next;
      updateScopes();
    },
    setRead: (next: boolean) => {
      read = next;
      updateScopes();
    },
    setPrefixes: (next: string[]) => {
      prefixes = [...next];
    },
    setStatus: (action: Action, status: number) => statuses.set(action, status),
    hold: (action: Action) =>
      gates.set(action, new Promise<void>((resolve) => releases.set(action, resolve))),
    release,
    releaseAll: () => {
      for (const action of [...gates.keys()]) release(action);
    },
  };
}
export type RoutingToggleGateway = Awaited<ReturnType<typeof install>>;
export const test = base.extend<{ gateway: RoutingToggleGateway }>({
  gateway: async ({ context }, runTest) => {
    const gateway = await install(context);
    try {
      await runTest(gateway);
    } finally {
      gateway.releaseAll();
      expect(gateway.unexpected).toEqual([]);
    }
  },
});
