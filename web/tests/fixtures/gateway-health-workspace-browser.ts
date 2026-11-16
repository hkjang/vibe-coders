import type { Page } from "@playwright/test";
import { installOverviewWorkspace } from "./overview-workspace-browser";

export async function installGatewayHealthWorkspace(page: Page) {
  const fixture = await installOverviewWorkspace(page);
  const bootstrap = fixture.bootstrap;
  if (!bootstrap.user) throw new Error("Missing fixture identity");
  bootstrap.backend_version = "v0.86.105";
  bootstrap.user.role = "admin";
  bootstrap.user.roles = ["admin"];
  bootstrap.roles = ["admin"];
  bootstrap.permissions.push("routing:write");
  bootstrap.user.scopes = bootstrap.permissions;
  for (const feature of bootstrap.migration_registry) {
    feature.enabled_roles = ["admin"];
    feature.read_only = false;
  }
  const state = {
    deny: false,
    failOnce: false,
    reads: 0,
    windows: [] as string[],
    writes: [] as { provider: string }[],
  };
  const ref = `prv_${"a".repeat(43)}`;
  const provider = {
    provider: "사내 분석 공급자",
    provider_ref: ref,
    score: 62,
    requests: 120,
    average_latency_ms: 420,
    p95_latency_ms: 810,
    timeouts: 2,
    rate_429: 1,
    rate_5xx: 3,
    fallbacks: 6,
    fallback_rate: 0.05,
  };
  const health = {
    since: "2026-09-01T00:00:00Z",
    until: "2026-09-02T00:00:00Z",
    threshold: 70,
    providers: [provider],
    ranking: [{ ...provider, rank: 1 }],
    degraded: [provider],
    alerts: [
      {
        provider: provider.provider,
        provider_ref: ref,
        severity: "warning",
        code: "provider_degraded",
        message: "internal-message",
      },
    ],
    trend: [],
    breakers: {
      enabled: true,
      threshold: 3,
      cooldown_seconds: 30,
      states: [
        {
          provider: provider.provider,
          provider_ref: ref,
          phase: "open",
          failures: 3,
          opens: 1,
          retry_in_seconds: 12,
        },
      ],
      shared: true,
      instance_id: "fixture",
    },
  };
  await page.route("**/admin/routing/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/admin/routing/health") {
      state.reads++;
      state.windows.push(url.searchParams.get("window") ?? "");
      if (state.deny) return route.fulfill({ status: 403, json: { error: { message: "denied" } } });
      if (state.failOnce) {
        state.failOnce = false;
        return route.fulfill({
          status: 503,
          json: { error: { message: "unavailable" } },
          headers: { "X-Request-ID": "gateway-health-fixture" },
        });
      }
      return route.fulfill({ json: health });
    }
    if (
      request.method() === "POST" &&
      ["/admin/routing/breaker-reset", "/admin/routing/balancer"].includes(url.pathname)
    ) {
      const body = request.postDataJSON() as { provider: string };
      if (!bootstrap.user?.scopes?.includes("routing:write") || state.deny)
        return route.fulfill({ status: 403, json: { error: { message: "denied" } } });
      state.writes.push(body);
      return route.fulfill({ json: { status: "reset" } });
    }
    return route.fallback();
  });
  return { ...fixture, state };
}
