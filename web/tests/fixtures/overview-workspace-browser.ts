import type { Page } from "@playwright/test";
import { migrationRegistry } from "../../src/config/migration-registry";
import { installSettingsWorkspace } from "./settings-workspace-browser";

const provider = {
  provider: "openai",
  provider_ref: `prv_${"a".repeat(43)}`,
  score: 92,
  requests: 120,
  average_latency_ms: 180.5,
  p95_latency_ms: 280,
  timeouts: 1,
  rate_429: 2,
  rate_5xx: 0,
  fallbacks: 3,
  fallback_rate: 0.025,
} as const;

const operations = {
  generated_at: "2026-09-02T01:02:03Z",
  providers: [provider],
  logging: { queue_depth: 2, written: 100, dropped: 0 },
  fallback: {
    path: "/data/fallback.ndjson",
    exists: true,
    lines: 4,
    bytes: 2_048,
    modified_at: "2026-09-02T01:00:00Z",
  },
  security: {
    auth_enabled: true,
    dev_secret: false,
    raw_prompts_logged: false,
    raw_bodies_logged: false,
    pricing_configured: true,
  },
  disk: {
    path: "/data",
    available: true,
    free_bytes: 1_000_000,
    total_bytes: 2_000_000,
    used_percent: 50,
  },
} as const;

const stats = {
  total_requests: 12,
  total_tokens: 300,
  total_cost_krw: 4_200,
  average_latency_ms: 125.2,
  by_ip: [],
  by_model: [],
  by_language: [],
  by_status: [{ class: "2xx", requests: 9 }],
  top_users: [],
  latency_quantiles: { p50: 100, p95: 250, p99: 400 },
  first_chunk_quantiles: { p50: 20, p95: 50, p99: 80 },
  cache: { entries: 1, bytes: 256, total_hits: 3, top_models: [] },
  failover_total: 2,
  cache_hits: 3,
  cache_misses: 1,
} as const;

const routing = {
  since: "2026-09-02T00:00:00Z",
  until: "2026-09-02T01:00:00Z",
  threshold: 70,
  providers: [provider],
  ranking: [
    {
      rank: 1,
      provider: "openai",
      provider_ref: `prv_${"a".repeat(43)}`,
      score: 92,
      requests: 120,
      fallback_rate: 0.025,
      p95_latency_ms: 280,
      average_latency_ms: 180.5,
    },
  ],
  degraded: [],
  alerts: [],
  trend: [],
  breakers: {
    enabled: true,
    threshold: 5,
    cooldown_seconds: 30,
    states: [],
    shared: false,
    instance_id: "gateway-1",
  },
} as const;

export async function installOverviewWorkspace(page: Page) {
  const fixture = await installSettingsWorkspace(page, "readonly_admin");
  const bootstrap = fixture.bootstrap;
  const base = bootstrap.migration_registry[0];
  if (!base || !bootstrap.user) throw new Error("Missing fixture identity");
  const ids = new Set([
    "overview",
    "gateway.health",
    "gateway.providers",
    "gateway.models",
    "system.health",
    "routing.rules",
    "observability.requests",
    "finops.overview",
  ]);
  bootstrap.backend_version = "v0.86.104";
  bootstrap.ui.default_entry = "/app/overview";
  bootstrap.migration_registry = migrationRegistry
    .filter((feature) => ids.has(feature.featureId))
    .map((feature) => ({
      ...base,
      feature_id: feature.featureId,
      title: feature.title,
      app_path: feature.appPath,
      legacy_path: feature.legacyPath,
      required_permission: feature.requiredPermission ?? "admin:read",
      read_only: true,
    }));
  bootstrap.allowed_features = [...ids];
  bootstrap.user.features = Object.fromEntries([...ids].map((id) => [id, true]));
  bootstrap.permissions = bootstrap.user.scopes = [
    "admin:read",
    "routing:read",
    "observability:read",
    "costs:read",
  ];
  const state = {
    denyStats: false,
    failOperations: false,
    empty: false,
    reads: {} as Record<string, number>,
    routingWindows: [] as string[],
  };
  await page.route("**/admin/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, json: body, headers: { "X-Request-ID": "overview-fixture" } });
    const known = [
      "/admin/stats",
      "/admin/ops/risk",
      "/admin/routing/health",
      "/admin/routing/balancer",
      "/admin/capabilities",
      "/admin/timeseries",
      "/admin/heatmap",
    ];
    if (!known.includes(url.pathname)) return route.fallback();
    if (request.method() !== "GET") {
      fixture.writes.push(request);
      return json({ error: { message: "unexpected write" } }, 405);
    }
    state.reads[url.pathname] = (state.reads[url.pathname] ?? 0) + 1;
    switch (url.pathname) {
      case "/admin/stats":
        return state.denyStats
          ? json({ error: { message: "denied" } }, 403)
          : json({ ...stats, total_requests: state.empty ? 0 : stats.total_requests });
      case "/admin/ops/risk":
        return state.failOperations
          ? json({ error: { message: "unavailable" } }, 503)
          : json({ risk: { score: 10, tier: "low", factors: [] }, status: operations });
      case "/admin/routing/health":
        state.routingWindows.push(url.searchParams.get("window") ?? "");
        return json(routing);
      case "/admin/routing/balancer":
        return json({
          mode: "session_hash",
          multi_instance_safe: true,
          sticky_sessions: true,
          sticky_ttl: "30m0s",
          active_sessions: 0,
          balance_index: 1,
          pools: [],
        });
      case "/admin/capabilities":
        return json({ count: 0, groups: {}, capabilities: [] });
      case "/admin/timeseries":
        return json({ bucket: "day", since: "2026-09-01T00:00:00Z", points: [] });
      case "/admin/heatmap":
        return json({ since: "2026-09-01T00:00:00Z", cells: [] });
    }
  });
  await page.clock.setFixedTime(new Date("2026-09-02T04:00:00Z"));
  return { ...fixture, state };
}
