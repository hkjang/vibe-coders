import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { UiBootstrapResponse } from "../../../src/shared/api/generated";
import type { Provider } from "../../../src/shared/api/schemas";
import type { ProviderConnectionResult } from "../../../src/shared/api/domains/provider-connection.schemas";
import { impactFixture } from "./provider-impact";

export const providerName = "public-connection-provider";
export const providerRef = `prv_${"a".repeat(43)}`;
export const originalURL = "https://catalogue.example.invalid/base";
export const draftURL = "https://draft.example.invalid/base";
export const draftKey = "public-synthetic-connection-key";
export const account = {
  id: "connection-fixture-admin",
  email: "connection@example.invalid",
  name: "연결 검사 운영자",
  role: "admin",
  roles: ["admin"],
  team_id: "public-team",
  scopes: ["admin:read", "admin:write", "routing:read"],
};
export const success: ProviderConnectionResult = {
  outcome: "catalog_available",
  upstream_status: 200,
  duration_ms: 12,
  timeout_ms: 10000,
  model_count: 2,
};
type Reply = { status?: number; body: unknown };
type Hold = { promise: Promise<void>; release: () => void };

async function installGateway(context: BrowserContext, origin: string) {
  let readOnly = false;
  let status: "preview" | "preview_read_only" = "preview";
  const sessions = new Set<string>();
  const unexpected: string[] = [];
  const probes: Record<string, unknown>[] = [];
  const saves: Record<string, unknown>[] = [];
  const replies = new Map<number, Reply>();
  const holds = new Map<number, Hold>();
  const finished: number[] = [];
  let refreshes = 0;
  let providers: Provider[] = [
    {
      name: providerName,
      provider_ref: providerRef,
      base_url: originalURL,
      api_key_configured: true,
      timeout_ms: 30000,
      enabled: true,
      model_patterns: "public-*",
      failover_group: "public-group",
      priority: 1,
      created_at: "2026-09-30T00:00:00Z",
    },
  ];
  function bootstrap(authenticated: boolean): UiBootstrapResponse {
    return {
      backend_version: "v0.86.29",
      ui_version: "synthetic-provider-connection",
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
        credential_prefixes: ["corp_"],
      },
      ...(authenticated ? { user: account } : {}),
      roles: authenticated ? account.roles : [],
      permissions: authenticated ? account.scopes : [],
      capabilities: { raw_prompt_view: false },
      allowed_features: authenticated ? ["gateway.providers"] : [],
      migration_registry: [
        {
          feature_id: "gateway.providers",
          title: "AI 공급자",
          app_path: "/app/gateway/providers",
          legacy_path: "/admin#/settings",
          status,
          risk_level: "medium",
          required_permission: "admin:read",
          read_only: readOnly,
          enabled_roles: ["admin"],
          rollout_percent: 100,
          fallback_enabled: true,
          minimum_api_version: "v0.84.0",
          available: authenticated,
        },
      ],
      system_status: { status: "healthy" },
      legacy_route_map: { "/app/gateway/providers": "/admin#/settings" },
    };
  }
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const call = `${request.method()} ${url.pathname}`;
    if (url.origin !== origin) {
      unexpected.push(`external ${request.method()} ${url.origin}`);
      return route.abort("blockedbyclient");
    }
    // Record attempts before processing. The fixture does NOT enforce runtime
    // readonly, current UI authorization, single-flight or draft validation.
    let probe = 0;
    if (call === "POST /admin/provider-connection-test") {
      probes.push(request.postDataJSON() as Record<string, unknown>);
      probe = probes.length;
    }
    if (call === "POST /admin/providers") saves.push(request.postDataJSON() as Record<string, unknown>);
    if (call === "POST /auth/refresh") refreshes += 1;
    const json = (body: unknown, responseStatus = 200) =>
      route.fulfill({
        status: responseStatus,
        contentType: "application/json",
        headers: { "X-Request-ID": "req-public-provider-connection", "Cache-Control": "no-store" },
        body: JSON.stringify(body),
      });
    if (call === "POST /auth/login") {
      expect(request.postDataJSON()).toEqual({ email: account.email, password: "public-password" });
      sessions.add("Bearer public-connection-access");
      return json({
        access_token: "public-connection-access",
        refresh_token: "public-connection-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_expires_in: 7200,
        user: account,
      });
    }
    const authenticated = sessions.has(request.headers().authorization ?? "");
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap(authenticated));
    if (call === "GET /health") return json({ status: "ok" });
    if (call === "GET /ready") return json({ status: "ready" });
    if (url.pathname.startsWith("/admin/") || url.pathname.startsWith("/auth/")) {
      if (!authenticated) {
        unexpected.push(`unauthenticated ${call}`);
        return json({ error: { message: "fixture authentication required" } }, 401);
      }
      if (probe) {
        expect(url.search).toBe("");
        expect(request.headers()["x-vibe-ui"]).toBe("app");
        expect(request.headers()["x-vibe-route"]).toBe("gateway.providers");
        await holds.get(probe)?.promise;
        const reply = replies.get(probe) ?? { body: success };
        await json(reply.body, reply.status ?? 200);
        finished.push(probe);
        return;
      }
      if (call === "GET /admin/providers") return json({ providers });
      if (call === "GET /admin/provider-impact")
        return json(impactFixture(url.searchParams.get("provider_ref") ?? ""));
      if (call === "GET /admin/providers/slo")
        return json({ slos: [], evaluations: [], since: "2026-09-30T00:00:00Z" });
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
          since: "2026-09-29T00:00:00Z",
          until: "2026-09-30T00:00:00Z",
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
        const body = saves.at(-1);
        if (!body || typeof body.name !== "string" || typeof body.base_url !== "string")
          return json({ error: { code: "invalid_body" } }, 400);
        const before = providers.find((provider) => provider.name === body.name);
        const next: Provider = {
          name: body.name,
          base_url: body.base_url.trim().replace(/\/+$/u, ""),
          provider_ref: before?.provider_ref ?? `prv_${"c".repeat(43)}`,
          api_key_configured:
            typeof body.api_key === "string" && body.api_key.trim() !== ""
              ? true
              : (before?.api_key_configured ?? false),
          timeout_ms: typeof body.timeout_ms === "number" ? body.timeout_ms : (before?.timeout_ms ?? 0),
          model_patterns: String(body.model_patterns ?? ""),
          failover_group: String(body.failover_group ?? ""),
          priority: Number(body.priority ?? before?.priority ?? 0),
          enabled: body.enabled === true,
          created_at: before?.created_at ?? "2026-09-30T00:00:00Z",
        };
        providers = [...providers.filter((provider) => provider.name !== next.name), next];
        return json({ ok: true });
      }
      unexpected.push(call);
      return json({ error: { message: "unexpected fixture request" } }, 501);
    }
    if (url.pathname.startsWith("/app/") || url.pathname === "/favicon.ico") return route.continue();
    unexpected.push(call);
    return route.abort("blockedbyclient");
  });
  return {
    probes,
    saves,
    finished,
    unexpected,
    refreshes: () => refreshes,
    provider: () => providers.find((row) => row.name === providerName),
    reply: (sequence: number, reply: Reply) => replies.set(sequence, reply),
    hold: (sequence: number) => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.set(sequence, { promise, release });
    },
    release: (sequence: number) => holds.get(sequence)?.release(),
    releaseAll: () => {
      for (const hold of holds.values()) hold.release();
    },
    readonly: (mode: "flag" | "status" | false) => {
      readOnly = mode === "flag";
      status = mode === "status" ? "preview_read_only" : "preview";
    },
  };
}

export type ConnectionGateway = Awaited<ReturnType<typeof installGateway>>;
export const test = base.extend<{ gateway: ConnectionGateway }>({
  gateway: async ({ context, baseURL }, run) => {
    if (!baseURL) throw new Error("Expected the local synthetic UI base URL");
    const gateway = await installGateway(context, new URL(baseURL).origin);
    try {
      await run(gateway);
    } finally {
      gateway.releaseAll();
      await context.unrouteAll({ behavior: "wait" });
      expect(gateway.unexpected).toEqual([]);
    }
  },
});
