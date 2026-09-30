import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { RoutingCostEstimate } from "../../src/shared/api/domains/routing";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// Synthetic browser transport only, not actual Go pricing, billing or provider
// execution. POST attempts are recorded before fixture validation/response work.
export const predictionUrl = "/app/routing/rules/preview";
export const predictionPath = "/admin/cost/predict";
export const requestId = "req-cost-public";
export const firstEmail = "cost-one@example.invalid";
export const secondEmail = "cost-two@example.invalid";
export const publicModel = "public-cost-model";
export type Mode = "writable" | "read_only" | "preview_read_only";
type Grants = { routingRead: boolean; adminRead: boolean; adminWrite: boolean };
const userFor = (email: string, grants: Grants) => ({
  id: email === secondEmail ? "cost-two" : "cost-one",
  email,
  name: "합성 비용 예측 사용자",
  role: "admin",
  roles: ["admin"],
  team_id: "public-team",
  scopes: [
    ...(grants.routingRead ? ["routing:read"] : []),
    ...(grants.adminRead ? ["admin:read"] : []),
    ...(grants.adminWrite ? ["admin:write"] : []),
  ],
  features: { "routing.rules": true },
});
type User = ReturnType<typeof userFor>;
export function estimateResult(model = publicModel, input = 1000): RoutingCostEstimate {
  return {
    model,
    input_tokens: input,
    output_tokens: 600,
    cost_krw: 12.5,
    latency_ms: 40,
    priced: true,
    basis: "history",
  };
}
function bootstrap(user: User | undefined, mode: Mode, prefixes: string[]): UiBootstrapResponse {
  return {
    backend_version: "v0.86.27",
    ui_version: "cost-prediction-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: predictionUrl,
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
        app_path: "/app/routing/rules",
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
    legacy_route_map: { [predictionUrl]: "/admin#/routing" },
  };
}
type Operation = { sequence: number; body: Record<string, unknown>; userId: string };
type ResponsePlan = {
  status?: number;
  result?: RoutingCostEstimate;
  requestId?: string;
  gate?: Promise<void>;
  release?: () => void;
};
async function install(context: BrowserContext) {
  let mode: Mode = "writable",
    logins = 0,
    guardReads = 0,
    refreshes = 0;
  const grants: Grants = { routingRead: true, adminRead: true, adminWrite: true };
  let prefixes = ["vc_sk_", "vc_sa_"];
  const sessions = new Map<string, User>();
  const refreshSessions = new Map<string, { authorization: string; user: User }>();
  const operations: Operation[] = [],
    unexpected: string[] = [];
  const finished = new Set<number>();
  const plans = new Map<number, ResponsePlan>();
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      call = `${request.method()} ${path}`;
    const session = sessions.get(request.headers().authorization ?? "");
    const json = (body: unknown, status = 200, id = requestId) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "X-Request-ID": id },
        body: JSON.stringify(body),
      });
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      unexpected.push(`external ${call}`);
      return json({ error: { message: "No external requests in cost fixture" } }, 501);
    }
    if (call === "POST /auth/login") {
      const body = request.postDataJSON() as { email: string; password: string };
      expect([firstEmail, secondEmail]).toContain(body.email);
      expect(body.password).toBe("public-test-password");
      const user = userFor(body.email, grants),
        token = `public-cost-access-${++logins}`,
        refresh = `public-cost-refresh-${logins}`;
      sessions.set(`Bearer ${token}`, user);
      refreshSessions.set(refresh, { authorization: `Bearer ${token}`, user });
      return json({
        access_token: token,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_expires_in: 7200,
        user,
      });
    }
    if (call === "POST /auth/refresh") {
      refreshes++;
      // The shared client omits Bearer on refresh. Resolve the actual incoming
      // refresh body, then rotate only that synthetic session's token pair.
      const body = request.postDataJSON() as { refresh_token: string };
      const previous = refreshSessions.get(body.refresh_token);
      if (!previous) {
        unexpected.push("unknown synthetic refresh token");
        return json({ error: { message: "Synthetic refresh denied" } }, 401);
      }
      expect(Object.keys(body)).toEqual(["refresh_token"]);
      refreshSessions.delete(body.refresh_token);
      sessions.delete(previous.authorization);
      const access = `public-cost-access-${++logins}`,
        refresh = `public-cost-refresh-${logins}`;
      sessions.set(`Bearer ${access}`, previous.user);
      refreshSessions.set(refresh, { authorization: `Bearer ${access}`, user: previous.user });
      return json({
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_expires_in: 7200,
        user: previous.user,
      });
    }
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap(session, mode, prefixes));
    if (call === "GET /auth/me")
      return json({
        version: "v0.86.27",
        auth_enabled: true,
        credential_prefixes: prefixes,
        ...(session ? { user: session } : {}),
      });
    if (call === "GET /auth/sso/status")
      return json({ keycloak_enabled: false, allow_local_login: true, login_url: "/auth/keycloak/login" });
    if (call === "GET /health" || call === "GET /ready")
      return json({ status: path === "/health" ? "ok" : "ready" });
    if (
      !path.startsWith("/admin/") &&
      !path.startsWith("/auth/") &&
      !path.startsWith("/v1/") &&
      !path.startsWith("/mcp")
    )
      return route.continue();
    if (call === `POST ${predictionPath}`) {
      const body = request.postDataJSON() as Record<string, unknown>;
      const sequence = operations.length + 1;
      // JSON parsing precedes this record. No permission, readonly or numeric
      // rejection here: those UI boundaries cannot be faked by the fixture.
      operations.push({ sequence, body: structuredClone(body), userId: session?.id ?? "anonymous" });
      expect(session).toBeDefined();
      expect(request.headers()["x-vibe-ui"]).toBe("app");
      expect(Object.keys(body).sort()).toEqual(["input_tokens", "max_tokens", "model"]);
      const plan = plans.get(sequence) ?? {};
      const status = plan.status ?? 200;
      const result = plan.result ?? estimateResult(String(body.model), Number(body.input_tokens));
      await plan.gate;
      try {
        return await json(
          status === 200
            ? result
            : { error: { message: "Synthetic estimate unavailable", type: "server_error" } },
          status,
          plan.requestId,
        );
      } finally {
        finished.add(sequence);
      }
    }
    if (!session) {
      unexpected.push(`unauthenticated ${call}`);
      return json({ error: { message: "Synthetic session required" } }, 401);
    }
    if (call === "POST /auth/logout") {
      const body = request.postDataJSON() as { refresh_token: string };
      expect(refreshSessions.get(body.refresh_token)?.user.id).toBe(session.id);
      refreshSessions.delete(body.refresh_token);
      sessions.delete(request.headers().authorization ?? "");
      return json({ status: "logged_out" });
    }
    if (call === "GET /admin/cost") {
      guardReads++;
      // GET has its own admin:read requirement. This does not protect POST.
      if (!session.scopes.includes("admin:read"))
        return json({ error: { message: "Synthetic cost read forbidden" } }, 401);
      return json({ enabled: false, threshold_krw: 0 });
    }
    if (call === "GET /admin/routing-rules") return json({ rules: [] });
    unexpected.push(call);
    return json({ error: { message: "Unexpected cost fixture request" } }, 501);
  });
  return {
    operations,
    unexpected,
    finished,
    count: () => operations.length,
    guardReads: () => guardReads,
    refreshes: () => refreshes,
    setMode: (next: Mode) => {
      mode = next;
    },
    setGrants: (next: Partial<Grants>) => {
      Object.assign(grants, next);
      for (const user of sessions.values()) user.scopes = userFor(user.email, grants).scopes;
    },
    setPrefixes: (next: readonly string[]) => {
      prefixes = [...next];
    },
    plan: (sequence: number, options: Omit<ResponsePlan, "gate" | "release"> & { hold?: boolean } = {}) => {
      if (sequence <= operations.length || plans.has(sequence))
        throw new Error("Plan must precede a unique request");
      const response: ResponsePlan = {
        status: options.status,
        result: options.result ? structuredClone(options.result) : undefined,
        requestId: options.requestId,
      };
      if (options.hold)
        response.gate = new Promise<void>((resolve) => {
          response.release = resolve;
        });
      plans.set(sequence, response);
    },
    release: (sequence: number) => {
      plans.get(sequence)?.release?.();
    },
    releaseAll: () => {
      for (const plan of plans.values()) plan.release?.();
    },
  };
}
export type CostGateway = Awaited<ReturnType<typeof install>>;
export const test = base.extend<{ gateway: CostGateway }>({
  gateway: async ({ context }, provide) => {
    const gateway = await install(context);
    try {
      await provide(gateway);
    } finally {
      gateway.releaseAll();
      expect(gateway.unexpected).toEqual([]);
    }
  },
});
