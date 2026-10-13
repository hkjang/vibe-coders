import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";
import type { Provider } from "../../src/shared/api/schemas";

export const providerPath = "/app/gateway/providers";
export const ordinaryNames = Array.from({ length: 57 }, (_, i) => `provider-${String(i).padStart(2, "0")}`);
export const privateRefs = [`prv_${"A".repeat(43)}`, `prv_${"B".repeat(43)}`] as const;
const timestamp = "2026-10-12T00:00:00Z";
const bootstrap: UiBootstrapResponse = {
  backend_version: "v0.86.48",
  ui_version: "synthetic-provider-sorting",
  api_version: "v1",
  ui: {
    enabled: true,
    default_entry: providerPath,
    legacy_fallback: false,
    feedback_enabled: false,
    telemetry_enabled: false,
  },
  authentication: {
    enabled: false,
    authenticated: true,
    mode: "open",
    keycloak_enabled: false,
    allow_local_login: true,
    sso_login_url: "/auth/keycloak/login",
  },
  user: {
    id: "provider-reader",
    email: "reader@example.invalid",
    name: "공급자 조회자",
    role: "admin",
    roles: ["admin"],
    team_id: "public-team",
    scopes: ["admin:read"],
    features: { "gateway.providers": true },
  },
  roles: ["admin"],
  permissions: ["admin:read"],
  allowed_features: ["gateway.providers"],
  capabilities: { raw_prompt_view: false },
  migration_registry: [
    {
      feature_id: "gateway.providers",
      title: "공급자",
      app_path: providerPath,
      legacy_path: "/admin#/settings",
      status: "preview",
      risk_level: "medium",
      required_permission: "admin:read",
      read_only: true,
      enabled_roles: ["admin"],
      rollout_percent: 100,
      fallback_enabled: false,
      minimum_api_version: "v0.84.0",
      available: true,
    },
  ],
  system_status: { status: "healthy" },
  legacy_route_map: {},
};

function provider(name: string, index: number, overrides: Partial<Provider> = {}): Provider {
  return {
    name,
    provider_ref: `prv_${String(index).padStart(43, "x")}`,
    base_url: "https://public.example.invalid/v1",
    api_key_configured: true,
    enabled: true,
    timeout_ms: 30_000,
    model_patterns: "public-*",
    failover_group: "public",
    priority: 100,
    created_at: timestamp,
    ...overrides,
  };
}

async function install(context: BrowserContext) {
  const currentBootstrap = structuredClone(bootstrap);
  const holds = new Map<number, { promise: Promise<void>; release: () => void }>();
  let providerReads = 0;
  let failSlo = false;
  let providers = [
    ...ordinaryNames.map((name, index) => provider(name, index)),
    provider("[provider-name-omitted]", 57, { provider_ref: privateRefs[0], priority: 300 }),
    provider("[provider-name-omitted]", 58, { provider_ref: privateRefs[1], priority: 300 }),
    provider("a-late-slow", 59, { priority: 900, timeout_ms: 999_000 }),
    provider("z-late-zero", 60, { priority: 900, timeout_ms: 0 }),
  ].reverse();
  const reads: Array<{ path: string; query: string }> = [];
  const writes: string[] = [];
  const unexpected: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const call = `${request.method()} ${url.pathname}`;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      unexpected.push(`external ${call}`);
      return json({ error: { message: "External requests forbidden in fixture" } }, 501);
    }
    if (/^\/(admin|auth|v1|mcp)(\/|$)/u.test(url.pathname) && request.method() !== "GET") {
      // Observe attempted writes before refusing them; refusal is not an authorization proof.
      writes.push(call);
      return json({ error: { message: "No writes expected while exploring" } }, 501);
    }
    if (url.pathname === "/admin/ui-bootstrap") return json(currentBootstrap);
    if (url.pathname === "/health" || url.pathname === "/ready") return json({ status: "ok" });
    if (url.pathname === "/admin/providers" || url.pathname === "/admin/providers/slo") {
      reads.push({ path: url.pathname, query: url.search });
      if (url.pathname === "/admin/providers") await holds.get(++providerReads)?.promise;
      if (url.pathname === "/admin/providers/slo" && failSlo)
        return json({ error: { message: "public SLO read failed" } }, 503);
      return json(
        url.pathname === "/admin/providers" ? { providers } : { slos: [], evaluations: [], since: timestamp },
      );
    }
    if (/^\/(admin|auth|v1|mcp)(\/|$)/u.test(url.pathname)) {
      unexpected.push(call);
      return json({ error: { message: "Unexpected fixture endpoint" } }, 501);
    }
    return route.continue();
  });
  return {
    reads,
    writes,
    unexpected,
    owner(id: string) {
      if (currentBootstrap.user) currentBootstrap.user.id = id;
    },
    scopes(scopes: string[]) {
      if (currentBootstrap.user) currentBootstrap.user.scopes = scopes;
      currentBootstrap.permissions = scopes;
    },
    replace(next: Provider[]) {
      providers = structuredClone(next);
    },
    failSlo(failed: boolean) {
      failSlo = failed;
    },
    holdProviderRead(sequence: number) {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.set(sequence, { promise, release });
    },
    releaseProviderRead(sequence: number) {
      holds.get(sequence)?.release();
    },
    shrink(count: number) {
      providers = providers.filter((item) => ordinaryNames.slice(0, count).includes(item.name));
    },
  };
}

export const test = base.extend<{ providerGateway: Awaited<ReturnType<typeof install>> }>({
  providerGateway: async ({ context }, provide) => {
    await provide(await install(context));
  },
});
test.afterEach(async ({ providerGateway }, info) => {
  expect(providerGateway.writes).toEqual([]);
  expect(providerGateway.unexpected).toEqual([]);
  await info.attach("synthetic-provider-requests", {
    contentType: "application/json",
    body: JSON.stringify(providerGateway),
  });
});
