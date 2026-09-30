import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { RoutingPreview } from "../../src/shared/api/domains/routing";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// Synthetic browser evidence only. No Go authorization, upstream execution,
// server-side cancellation, audit or sample persistence contract is established.
export const previewUrl = "/app/routing/rules/preview";
export const previewPath = "/admin/routing/preview";
export const requestId = "req-preview-public";
export const firstEmail = "preview-one@example.invalid";
export const secondEmail = "preview-two@example.invalid";
export const publicModel = "public-request-model";
export const sampleA = "공개 합성 샘플 A 전용 표식";
export const sampleB = "공개 합성 샘플 B 전용 표식";
export type Mode = "writable" | "read_only" | "preview_read_only";
export function previewResult(model = publicModel, keyId = ""): RoutingPreview {
  return {
    requested_model: model,
    selected_model: `${model}-selected`,
    selected_provider: "공개 합성 공급자",
    policy_api_key_id: keyId,
    complexity: { score: 10, tier: "simple" },
    risk: { score: 0, tier: "low", categories: [] },
    health_score: 100,
    fallback_plan: ["no_provider_failover:single_matching_provider"],
    route_reason: "complexity_rule",
    decision_reason: "공개 합성 경로 계산",
    would_rewrite: true,
  };
}
const userFor = (email: string, read: boolean) => ({
  id: email === secondEmail ? "preview-two" : "preview-one",
  email,
  name: "합성 라우팅 조회 사용자",
  role: "admin",
  roles: ["admin"],
  team_id: "public-team",
  scopes: read ? ["routing:read"] : [],
  features: { "routing.rules": true },
});
type User = ReturnType<typeof userFor>;
function bootstrap(user: User | undefined, mode: Mode, prefixes: string[]): UiBootstrapResponse {
  return {
    backend_version: "v0.86.26",
    ui_version: "routing-preview-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: previewUrl,
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
    legacy_route_map: { [previewUrl]: "/admin#/routing" },
  };
}
type Operation = { sequence: number; body: Record<string, unknown>; userId: string };
type ResponsePlan = { status?: number; result?: RoutingPreview; gate?: Promise<void>; release?: () => void };

async function install(context: BrowserContext) {
  let mode: Mode = "writable",
    read = true,
    logins = 0;
  let prefixes = ["vc_sk_", "vc_sa_"];
  const sessions = new Map<string, User>();
  const operations: Operation[] = [],
    unexpected: string[] = [];
  const finished = new Set<number>();
  const plans = new Map<number, ResponsePlan>();
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const call = `${request.method()} ${path}`;
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
      return json({ error: { message: "No external requests in preview fixture" } }, 501);
    }
    if (call === "POST /auth/login") {
      const body = request.postDataJSON() as { email: string; password: string };
      expect([firstEmail, secondEmail]).toContain(body.email);
      expect(body.password).toBe("public-test-password");
      const user = userFor(body.email, read),
        token = `public-preview-access-${++logins}`;
      sessions.set(`Bearer ${token}`, user);
      return json({
        access_token: token,
        refresh_token: `public-preview-refresh-${logins}`,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_expires_in: 7200,
        user,
      });
    }
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap(session, mode, prefixes));
    if (call === "GET /auth/me")
      return json({
        version: "v0.86.26",
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
    if (call === `POST ${previewPath}`) {
      const body = request.postDataJSON() as Record<string, unknown>;
      const sequence = operations.length + 1;
      // Record before response/body handling. Never enforce current scope,
      // feature readonly or secret detection on behalf of the product UI.
      operations.push({ sequence, body: structuredClone(body), userId: session?.id ?? "anonymous" });
      expect(session).toBeDefined();
      expect(request.headers()["x-vibe-ui"]).toBe("app");
      expect(Object.keys(body).sort()).toEqual(
        body.api_key_id === undefined ? ["messages", "model"] : ["api_key_id", "messages", "model"],
      );
      expect(typeof body.model).toBe("string");
      expect(body.messages).toEqual([{ role: "user", content: expect.any(String) }]);
      if (body.api_key_id !== undefined) expect(typeof body.api_key_id).toBe("string");
      const plan = plans.get(sequence) ?? {};
      const status = plan.status ?? 200;
      const response = plan.result ?? previewResult(String(body.model), String(body.api_key_id ?? ""));
      await plan.gate;
      try {
        return await json(
          status === 200
            ? response
            : {
                error: {
                  message: "Synthetic preview unavailable",
                  type: "server_error",
                  code: "synthetic_preview",
                },
              },
          status,
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
      sessions.delete(request.headers().authorization ?? "");
      return json({ status: "logged_out" });
    }
    // Only supporting read fixtures. This is not proof that routing:read
    // authorizes the real cost endpoint; the adjacent card is outside scope.
    if (call === "GET /admin/cost") return json({ enabled: false, threshold_krw: 0 });
    if (call === "GET /admin/routing-rules") return json({ rules: [] });
    unexpected.push(call);
    return json({ error: { message: "Unexpected preview fixture request" } }, 501);
  });
  return {
    operations,
    unexpected,
    finished,
    count: () => operations.length,
    setMode: (next: Mode) => {
      mode = next;
    },
    setRead: (next: boolean) => {
      read = next;
      for (const user of sessions.values()) user.scopes = userFor(user.email, read).scopes;
    },
    setPrefixes: (next: readonly string[]) => {
      prefixes = [...next];
    },
    plan: (sequence: number, options: { status?: number; result?: RoutingPreview; hold?: boolean } = {}) => {
      if (sequence <= operations.length || plans.has(sequence))
        throw new Error("Plan must precede a unique request");
      const response: ResponsePlan = {
        status: options.status,
        result: options.result ? structuredClone(options.result) : undefined,
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
export type PreviewGateway = Awaited<ReturnType<typeof install>>;
export const test = base.extend<{ gateway: PreviewGateway }>({
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
