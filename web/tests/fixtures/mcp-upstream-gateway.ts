import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

export const first = {
  id: "first-server",
  name: "첫 번째 MCP 서버",
  url: "https://example.invalid/mcp",
  enabled: true,
  has_auth: false,
  created_at: "2026-10-01T00:00:00Z",
  metadata: {},
};
export const second = { ...first, id: "second-server", name: "두 번째 MCP 서버" };
type Mode = "writable" | "read_only" | "preview_read_only" | "no_read";
function bootstrap(mode: Mode): UiBootstrapResponse {
  const scopes = ["admin:read", "mcp:admin", ...(mode === "no_read" ? [] : ["observability:read"])];
  const user = {
    id: "mcp-fixture",
    email: "mcp@example.invalid",
    name: "합성 운영자",
    role: "admin",
    roles: ["admin"],
    team_id: "fixture",
    scopes,
    features: { "mcp.overview": true },
  };
  return {
    backend_version: "v0.86.58",
    ui_version: "mcp-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/mcp",
      legacy_fallback: true,
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
    user,
    roles: user.roles,
    permissions: scopes,
    allowed_features: ["mcp.overview"],
    capabilities: { raw_prompt_view: false },
    migration_registry: [
      {
        feature_id: "mcp.overview",
        title: "MCP 서버",
        app_path: "/app/mcp",
        legacy_path: "/admin#/mcp",
        status: mode === "preview_read_only" ? "preview_read_only" : "preview",
        read_only: mode === "read_only",
        risk_level: "medium",
        required_permission: "admin:read",
        enabled_roles: [],
        rollout_percent: 100,
        fallback_enabled: true,
        minimum_api_version: "v0.84.0",
        available: true,
      },
    ],
    system_status: { status: "healthy" },
    legacy_route_map: { "/app/mcp": "/admin#/mcp" },
  };
}
async function install(context: BrowserContext) {
  let mode: Mode = "writable";
  let release: () => void = () => undefined;
  let pending: Promise<void> | undefined;
  let hold = false;
  const reads: string[] = [],
    writes: string[] = [],
    searches: unknown[] = [],
    unexpected: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const call = `${request.method()} ${path}`;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      unexpected.push(call);
      return route.abort();
    }
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap(mode));
    if (call === "GET /health" || call === "GET /ready") return json({ status: "ok" });
    if (call === "POST /admin/resource-search") {
      searches.push(request.postDataJSON());
      return json({
        request_id: "fixture-search",
        groups: [
          {
            kind: "mcp_upstream",
            status: "ok",
            limited: false,
            items: [{ kind: "mcp_upstream", id: first.id, title: first.name }],
          },
        ],
      });
    }
    if (call === "GET /admin/mcp/upstreams") {
      reads.push(call);
      return json({ upstreams: [first, second], discovery_errors: {} });
    }
    if (
      request.method() === "GET" &&
      /^\/admin\/mcp\/upstreams\/(first-server|second-server)\/flow$/.test(path)
    ) {
      reads.push(call);
      return json({ steps: [], discovery_runs: [], recent_requests: [] });
    }
    // The fixture accepts writes even in read-only mode: the UI must prevent them.
    if (path.startsWith("/admin/mcp/") && request.method() !== "GET") {
      writes.push(call);
      if (path.endsWith("/probe")) {
        if (hold) await pending;
        return json({
          ok: true,
          id: first.id,
          tool_count: 1,
          prompt_count: 0,
          resource_count: 0,
          tools: [{ name: "first-server-only-tool" }],
          prompts: [],
          resources: [],
          errors: {},
        });
      }
      return json({ upstream: first, id: first.id, status: "deleted" });
    }
    if (/^\/(admin|auth|me|v1|mcp)(\/|$)/.test(path)) {
      unexpected.push(call);
      return json({ error: { message: "Unexpected synthetic request" } }, 501);
    }
    return route.continue();
  });
  return {
    reads,
    writes,
    searches,
    unexpected,
    setMode(value: Mode) {
      mode = value;
    },
    holdProbe() {
      hold = true;
      pending = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    releaseProbe() {
      hold = false;
      release();
    },
  };
}
export const test = base.extend<{ gateway: Awaited<ReturnType<typeof install>> }>({
  gateway: async ({ context }, runFixture) => {
    const gateway = await install(context);
    try {
      await runFixture(gateway);
    } finally {
      gateway.releaseProbe();
    }
    expect(gateway.unexpected).toEqual([]);
  },
});
