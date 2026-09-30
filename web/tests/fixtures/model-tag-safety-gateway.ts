import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";
import type { ModelUsageTag } from "../../src/shared/api/schemas";

// Synthetic transport only. Real Go authentication, exact-ID persistence and
// normalization contracts are a separate lane, not browser evidence.
export const tagsUrl = "/app/gateway/chat?tab=tags";
export const providersUrl = "/app/gateway/providers";
export const listPath = "/admin/model-tags";
export const modelA = "public-tag-a";
export const modelB = "public-tag-b";
export const firstEmail = "tag-one@example.invalid";
export const secondEmail = "tag-two@example.invalid";
export const readonlyReason = "이 화면은 읽기 전용입니다. 변경 저장과 실제 외부 실행을 할 수 없습니다.";
export const timestamp = "2026-09-30T01:00:00Z";
export const row = (model = modelA, good_for = "공개 원본 A"): ModelUsageTag => ({
  model,
  good_for,
  avoid_for: "공개 부적합",
  risk_note: "공개 위험 메모",
  updated_by: "public-original-operator",
  updated_at: timestamp,
});
export type Mode = "writable" | "read_only" | "preview_read_only";
export type Action = "list" | "save" | "delete";
type Operation = {
  action: Action;
  path: string;
  id?: string;
  body: Record<string, unknown> | null;
  userId: string;
};
const userFor = (email: string, read: boolean, write: boolean) => ({
  id: email === secondEmail ? "tag-two" : "tag-one",
  email,
  name: "합성 태그 운영자",
  role: "admin",
  roles: ["admin"],
  team_id: "public-team",
  scopes: [...(read ? ["admin:read"] : []), ...(write ? ["admin:write"] : [])],
  features: { "gateway.chat": true, "gateway.providers": true },
});
type User = ReturnType<typeof userFor>;
function bootstrap(user: User | undefined, mode: Mode): UiBootstrapResponse {
  return {
    backend_version: "v0.86.23",
    ui_version: "model-tag-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: tagsUrl,
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
    roles: user?.roles ?? [],
    permissions: user?.scopes ?? [],
    allowed_features: user ? ["gateway.chat", "gateway.providers"] : [],
    // Tags do not require raw-prompt view. Do not accidentally grant it here.
    capabilities: { raw_prompt_view: false },
    migration_registry: [
      {
        feature_id: "gateway.chat",
        title: "채팅 테스트",
        app_path: "/app/gateway/chat",
        legacy_path: "/admin#/chat-test",
        status: mode === "preview_read_only" ? "preview_read_only" : "preview",
        read_only: mode === "read_only",
      },
      {
        feature_id: "gateway.providers",
        title: "AI 공급자",
        app_path: providersUrl,
        legacy_path: "/admin#/settings",
        status: "preview_read_only",
        read_only: true,
      },
    ].map((feature) => ({
      ...feature,
      status: feature.status as "preview" | "preview_read_only",
      risk_level: "medium",
      required_permission: "admin:read",
      enabled_roles: [],
      rollout_percent: 100,
      fallback_enabled: true,
      minimum_api_version: "v0.86.10",
      available: Boolean(user),
    })),
    system_status: { status: "healthy" },
    legacy_route_map: { "/app/gateway/chat": "/admin#/chat-test", [providersUrl]: "/admin#/settings" },
  };
}
async function install(context: BrowserContext) {
  let mode: Mode = "writable",
    read = true,
    write = true,
    logins = 0,
    revision = 0;
  let rows = [row(), row(modelB, "공개 원본 B")];
  const sessions = new Map<string, User>();
  const operations: Operation[] = [],
    finished: Action[] = [],
    unexpected: string[] = [];
  const statuses = new Map<Action, number>(),
    payloads = new Map<Action, unknown>();
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
        headers: { "X-Request-ID": "req-model-tag-safety" },
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
        access = `public-tag-access-${++logins}`;
      sessions.set(`Bearer ${access}`, user);
      return json({
        access_token: access,
        refresh_token: `public-tag-refresh-${logins}`,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_expires_in: 7200,
        user,
      });
    }
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap(session, mode));
    if (call === "GET /auth/me")
      return json({ version: "v0.86.23", auth_enabled: true, ...(session ? { user: session } : {}) });
    if (call === "GET /auth/sso/status")
      return json({ keycloak_enabled: false, allow_local_login: true, login_url: "/auth/keycloak/login" });
    if (call === "GET /health" || call === "GET /ready")
      return json({ status: path === "/health" ? "ok" : "ready" });
    if (path.startsWith("/v1/") || path.startsWith("/mcp")) {
      unexpected.push(`runtime ${call}`);
      return json({ error: { message: "No model execution in tag tests" } }, 501);
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
    // Read-only routing fixtures exist solely for real navigation/back tests.
    if (call === "GET /admin/providers") return json({ providers: [] });
    if (call === "GET /admin/providers/slo") return json({ slos: [], evaluations: [], since: timestamp });
    if (call === "GET /admin/routing/health")
      return json({
        since: timestamp,
        until: timestamp,
        threshold: 70,
        providers: [],
        ranking: [],
        degraded: [],
        alerts: [],
        trend: [],
        breakers: {
          enabled: false,
          threshold: 3,
          cooldown_seconds: 30,
          states: [],
          shared: false,
          instance_id: "public-tags",
        },
      });
    if (call === "GET /admin/chat-test/targets")
      return json({ targets: [], defaults: { model: "vibe/auto" } });
    const action: Action | undefined =
      path === listPath && method === "GET"
        ? "list"
        : path === listPath && method === "POST"
          ? "save"
          : path.startsWith(`${listPath}/`) && method === "DELETE"
            ? "delete"
            : undefined;
    if (!action) {
      unexpected.push(call);
      return json({ error: { message: "Unexpected synthetic request" } }, 501);
    }
    const body = action === "save" ? (request.postDataJSON() as Record<string, unknown>) : null;
    // Decode once. `%252F` and `%2F` identify distinct stored strings.
    const id = action === "delete" ? decodeURIComponent(path.slice(listPath.length + 1)) : undefined;
    operations.push({ action, path, id, body: structuredClone(body), userId: session.id });
    expect(request.headers()["x-vibe-ui"]).toBe("app");
    // No readonly/scope enforcement: an escaped UI write must remain observable.
    const status = statuses.get(action) ?? 200;
    let response: unknown = { tags: structuredClone(rows) };
    if (action === "save" && status === 200) {
      expect(typeof body?.model).toBe("string");
      // Go's decoder accepts omitted/null optional strings, not numbers or
      // objects. Do not conceal an invalid UI payload with String(value).
      for (const field of ["good_for", "avoid_for", "risk_note", "updated_by", "updated_at"])
        expect(body?.[field] == null || typeof body[field] === "string").toBe(true);
      const guidance = (field: string) => (typeof body?.[field] === "string" ? (body[field] as string) : "");
      const model = String(body?.model).replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
      const saved: ModelUsageTag = {
        model,
        good_for: guidance("good_for"),
        avoid_for: guidance("avoid_for"),
        risk_note: guidance("risk_note"),
        updated_by: session.id,
        updated_at: `2026-09-30T01:00:${String(++revision).padStart(2, "0")}Z`,
      };
      rows = [...rows.filter((candidate) => candidate.model !== model), saved];
      response = { ...saved };
    } else if (action === "delete" && status === 200) {
      rows = rows.filter((candidate) => candidate.model !== id);
      response = { status: "deleted" };
    }
    if (payloads.has(action)) response = structuredClone(payloads.get(action));
    await gates.get(action);
    try {
      return await json(
        status === 200
          ? response
          : {
              error: {
                message: "Synthetic tag operation unavailable",
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
  const scopes = () => {
    for (const user of sessions.values()) user.scopes = userFor(user.email, read, write).scopes;
  };
  return {
    operations,
    finished,
    unexpected,
    count: (action: Action) => operations.filter((item) => item.action === action).length,
    records: () => structuredClone(rows),
    // Includes explicitly imported rows; not every seed is HTTP-creatable.
    setRows: (next: ModelUsageTag[]) => {
      rows = structuredClone(next);
    },
    setMode: (next: Mode) => {
      mode = next;
    },
    setRead: (next: boolean) => {
      read = next;
      scopes();
    },
    setWrite: (next: boolean) => {
      write = next;
      scopes();
    },
    setStatus: (action: Action, status: number) => statuses.set(action, status),
    setPayload: (action: Action, payload: unknown) => payloads.set(action, structuredClone(payload)),
    clearPayload: (action: Action) => payloads.delete(action),
    hold: (action: Action) =>
      gates.set(action, new Promise<void>((resolve) => releases.set(action, resolve))),
    release,
    releaseAll: () => {
      for (const action of [...gates.keys()]) release(action);
    },
  };
}
export type ModelTagGateway = Awaited<ReturnType<typeof install>>;
export const test = base.extend<{ gateway: ModelTagGateway }>({
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
