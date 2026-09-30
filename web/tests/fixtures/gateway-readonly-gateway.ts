import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";
import type { Provider, ProviderSLO } from "../../src/shared/api/schemas";
import { impactFixture } from "../e2e/fixtures/provider-impact";

// Synthetic FeatureRoute evidence only, not proof of server authorization or
// cancellation of operational writes. Existing test fixtures remain unchanged.
export type Feature = "gateway.providers" | "gateway.health";
export type Mode = "writable" | "read_only" | "preview_read_only";
export const providersUrl = "/app/gateway/providers";
export const healthUrl = "/app/gateway/health";
export const publicName = "readonly-gateway-provider";
export const publicRef = `prv_${"a".repeat(43)}`;
export const privateRef = `prv_${"b".repeat(43)}`;
export const originalUrl = "https://original.example.invalid/v1";
export const revisedUrl = "https://revised.example.invalid/v1";
export const firstEmail = "gateway-one@example.invalid";
export const secondEmail = "gateway-two@example.invalid";
export const reason = "이 화면은 읽기 전용입니다. 변경 저장과 실제 외부 실행을 할 수 없습니다.";
const timestamp = "2026-09-30T01:00:00Z";
const userFor = (email: string) => ({
  id: email === secondEmail ? "gateway-two" : "gateway-one",
  email,
  name: "합성 게이트웨이 운영자",
  role: "admin",
  roles: ["admin"],
  team_id: "fixture-team",
  scopes: ["admin:read", "admin:write", "routing:read", "routing:write"],
  features: { "gateway.providers": true, "gateway.health": true },
});
type User = ReturnType<typeof userFor>;
type Operation = { call: string; body: Record<string, unknown> | null; userId: string };
function bootstrap(user: User | undefined, modes: Record<Feature, Mode>): UiBootstrapResponse {
  return {
    backend_version: "v0.86.19",
    ui_version: "gateway-readonly-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: providersUrl,
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
      credential_prefixes: ["public-fixture-secret-"],
    },
    ...(user ? { user } : {}),
    roles: user?.roles ?? [],
    permissions: user?.scopes ?? [],
    allowed_features: user ? Object.keys(modes) : [],
    capabilities: { raw_prompt_view: false },
    migration_registry: (
      [
        {
          feature_id: "gateway.providers",
          title: "AI 공급자",
          app_path: providersUrl,
          legacy_path: "/admin#/settings",
          required_permission: "admin:read",
        },
        {
          feature_id: "gateway.health",
          title: "게이트웨이 상태",
          app_path: healthUrl,
          legacy_path: "/admin#/routing/health",
          required_permission: "routing:read",
        },
      ] as const
    ).map((feature) => ({
      ...feature,
      status: modes[feature.feature_id] === "preview_read_only" ? "preview_read_only" : "preview",
      read_only: modes[feature.feature_id] === "read_only",
      risk_level: "medium",
      enabled_roles: [],
      rollout_percent: 100,
      fallback_enabled: true,
      minimum_api_version: "v0.86.10",
      available: Boolean(user),
    })),
    system_status: { status: "healthy" },
    legacy_route_map: { [providersUrl]: "/admin#/settings", [healthUrl]: "/admin#/routing/health" },
  };
}
async function install(context: BrowserContext) {
  const modes: Record<Feature, Mode> = { "gateway.providers": "writable", "gateway.health": "writable" };
  const sessions = new Map<string, { user: User; refresh: string }>();
  const writes: Operation[] = [],
    reads: string[] = [],
    unexpected: string[] = [];
  const gates = new Map<string, Promise<void>>(),
    releases = new Map<string, () => void>();
  let logins = 0,
    writeStatus = 200,
    impactStatus = 200,
    routingStatus = 200;
  let healthName = publicName;
  let providers: Provider[] = [
    {
      name: publicName,
      provider_ref: publicRef,
      base_url: originalUrl,
      api_key_configured: true,
      timeout_ms: 30000,
      enabled: true,
      model_patterns: "public-model-*",
      failover_group: "public-group",
      priority: 1,
      created_at: timestamp,
    },
    {
      name: "[provider-name-omitted]",
      provider_ref: privateRef,
      base_url: "https://private.example.invalid/v1",
      api_key_configured: true,
      timeout_ms: 30000,
      enabled: false,
      model_patterns: "private-*",
      failover_group: "public-group",
      priority: 2,
      created_at: timestamp,
    },
  ];
  let slo: ProviderSLO = {
    provider: publicName,
    provider_ref: publicRef,
    availability_target: 0.99,
    p95_latency_target_ms: 5000,
    error_rate_target: 0.02,
    fallback_rate_target: 0.1,
    enabled: true,
    note: "기존 공개 SLO 메모",
    updated_at: timestamp,
  };
  const release = (key: string) => {
    releases.get(key)?.();
    releases.delete(key);
    gates.delete(key);
  };
  const routing = () => ({
    since: timestamp,
    until: timestamp,
    threshold: 70,
    providers: [],
    ranking: [],
    degraded: [],
    alerts: [],
    trend: [],
    breakers: {
      enabled: true,
      threshold: 3,
      cooldown_seconds: 30,
      shared: true,
      instance_id: "fixture",
      states: [
        {
          provider: healthName,
          provider_ref: publicRef,
          phase: "open",
          failures: 3,
          opens: 1,
          last_reason: "synthetic timeout",
          retry_in_seconds: 12,
        },
      ],
    },
  });
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      call = `${request.method()} ${path}`;
    const authorization = request.headers().authorization ?? "",
      session = sessions.get(authorization);
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "X-Request-ID": "req-gateway-readonly" },
        body: JSON.stringify(body),
      });
    if (call === "POST /auth/login") {
      const body = request.postDataJSON() as { email: string; password: string };
      expect([firstEmail, secondEmail]).toContain(body.email);
      expect(body.password).toBe("public-test-password");
      const user = userFor(body.email),
        access = `public-gateway-access-${++logins}`,
        refresh = `public-gateway-refresh-${logins}`;
      sessions.set(`Bearer ${access}`, { user, refresh });
      return json({
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_expires_in: 7200,
        user,
      });
    }
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap(session?.user, modes));
    if (call === "GET /auth/sso/status")
      return json({ keycloak_enabled: false, allow_local_login: true, login_url: "/auth/keycloak/login" });
    if (call === "GET /auth/me")
      return json({ version: "v0.86.19", auth_enabled: true, ...(session ? { user: session.user } : {}) });
    if (call === "GET /health" || call === "GET /ready") {
      reads.push(call);
      return json({ status: path === "/health" ? "ok" : "ready" });
    }
    if (!path.startsWith("/admin/") && !path.startsWith("/auth/")) return route.continue();
    if (!session) {
      unexpected.push(`unauthenticated ${call}`);
      return json({ error: { message: "Synthetic session required" } }, 401);
    }
    if (call === "POST /auth/logout") {
      sessions.delete(authorization);
      return json({ status: "logged_out" });
    }
    if (request.method() === "GET") {
      reads.push(call);
      if (call === "GET /admin/providers") return json({ providers });
      if (call === "GET /admin/providers/slo")
        return json({ slos: [slo], evaluations: [], since: timestamp });
      if (call === "GET /admin/routing/health")
        return routingStatus === 200
          ? json(routing())
          : json({ error: { message: "Synthetic health failure" } }, routingStatus);
      if (call === "GET /admin/routing/balancer")
        return json({
          mode: "session_hash",
          multi_instance_safe: true,
          sticky_sessions: true,
          sticky_ttl: "30m0s",
          active_sessions: 4,
          balance_index: 0.8,
          pools: [],
        });
      if (call === "GET /admin/provider-impact") {
        const ref = url.searchParams.get("provider_ref") ?? "";
        expect([...url.searchParams.keys()]).toEqual(["provider_ref"]);
        expect([publicRef, privateRef]).toContain(ref);
        await gates.get("impact");
        return impactStatus === 200
          ? json(impactFixture(ref))
          : json({ error: { message: "Synthetic impact failure" } }, impactStatus);
      }
    }
    const allowed = [
      "POST /admin/providers",
      "POST /admin/providers/slo",
      `DELETE /admin/providers/${publicName}`,
      `DELETE /admin/providers/${privateRef}`,
      "POST /admin/routing/breaker-reset",
      "POST /admin/routing/balancer",
    ];
    if (allowed.includes(call)) {
      const body = request.postData() ? (request.postDataJSON() as Record<string, unknown>) : null;
      expect(request.headers()["x-vibe-ui"]).toBe("app");
      writes.push(structuredClone({ call, body, userId: session.user.id }));
      const status = writeStatus;
      await gates.get("write");
      if (status !== 200) return json({ error: { message: "Synthetic operation failed" } }, status);
      if (call === "POST /admin/providers") {
        providers = providers.map((row) =>
          row.name === body?.name
            ? { ...row, base_url: String(body.base_url), enabled: body.enabled === true }
            : row,
        );
        return json({
          provider: providers.find((row) => row.name === body?.name) ?? { ...body, api_key: undefined },
        });
      } else if (call === "POST /admin/providers/slo") {
        slo = { ...slo, ...body };
        return json({ slo });
      } else if (request.method() === "DELETE") {
        const target = decodeURIComponent(path.slice("/admin/providers/".length));
        providers = providers.filter((row) => row.name !== target && row.provider_ref !== target);
        return json({ deleted: target });
      }
      return json({ ok: true, status: "reset", provider: body?.provider ?? "", states: [] });
    }
    unexpected.push(call);
    return json({ error: { message: "Unexpected gateway readonly fixture request" } }, 501);
  });
  return {
    writes,
    reads,
    unexpected,
    setMode: (feature: Feature, mode: Mode) => {
      modes[feature] = mode;
    },
    setScope: (scope: string, enabled: boolean) => {
      for (const { user } of sessions.values())
        user.scopes = [...user.scopes.filter((item) => item !== scope), ...(enabled ? [scope] : [])];
    },
    setWriteStatus: (status: number) => {
      writeStatus = status;
    },
    setImpactStatus: (status: number) => {
      impactStatus = status;
    },
    setRoutingStatus: (status: number) => {
      routingStatus = status;
    },
    changeReadModels: () => {
      providers = providers.map((row) =>
        row.name === publicName ? { ...row, base_url: "https://refreshed.example.invalid/v1" } : row,
      );
      slo = { ...slo, note: "재조회된 다른 SLO 메모" };
      healthName = "refreshed-health-provider";
    },
    hold: (key: "write" | "impact") => {
      gates.set(key, new Promise<void>((resolve) => releases.set(key, resolve)));
    },
    release,
  };
}
type Gateway = Awaited<ReturnType<typeof install>>;
export const test = base.extend<{ gateway: Gateway }>({
  gateway: async ({ context }, run) => {
    const gateway = await install(context);
    try {
      await run(gateway);
    } finally {
      gateway.release("write");
      gateway.release("impact");
      expect(gateway.unexpected).toEqual([]);
    }
  },
});
