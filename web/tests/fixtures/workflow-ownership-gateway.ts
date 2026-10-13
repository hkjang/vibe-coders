import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

export const first = {
  id: "wf_first",
  name: "첫 번째 업무",
  description: "합성 업무 정의",
  enabled: true,
  steps: [],
};
export const second = { ...first, id: "wf_second", name: "두 번째 업무" };
export type Mode = "writable" | "read_only" | "preview_read_only";
const appPath = "/app/agents/workflows";

export function bootstrap(mode: Mode): UiBootstrapResponse {
  const user = {
    id: "workflow-fixture",
    email: "workflow@example.invalid",
    name: "합성 운영자",
    role: "admin",
    roles: ["admin"],
    team_id: "fixture",
    scopes: ["admin:read", "admin:write"],
    features: { "agents.workflows": true },
  };
  return {
    backend_version: "v0.86.55",
    ui_version: "workflow-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: appPath,
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
    permissions: user.scopes,
    allowed_features: ["agents.workflows"],
    capabilities: { raw_prompt_view: false },
    migration_registry: [
      {
        feature_id: "agents.workflows",
        title: "워크플로",
        app_path: appPath,
        legacy_path: "/admin#/workflows",
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
    legacy_route_map: { [appPath]: "/admin#/workflows" },
  };
}

async function install(context: BrowserContext) {
  let mode: Mode = "writable";
  let hold = false;
  let release: () => void = () => undefined;
  let pending: Promise<void> | undefined;
  const writes: string[] = [],
    simulations: string[] = [],
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
    if (call === "GET /health") return json({ status: "ok" });
    if (call === "GET /ready") return json({ status: "ready" });
    if (call === "GET /admin/workflows") return json({ workflows: [first, second] });
    if (request.method() === "POST" && /^\/admin\/workflows\/wf_(first|second)\/dry-run$/.test(path)) {
      const id = path.split("/")[3];
      simulations.push(id ?? "");
      if (hold) await pending;
      return json({
        workflow_id: id,
        ok: true,
        steps: [],
        issues: [],
        note: id === first.id ? "첫 번째 업무 검사 근거" : "두 번째 업무 검사 근거",
      });
    }
    // Record attempted writes before replying; the fixture does not enforce readonly.
    if (path.startsWith("/admin/workflows") && request.method() !== "GET") {
      writes.push(call);
      return json({ ok: true, published: true, workflow_id: first.id, version: 1 });
    }
    if (/^\/(admin|auth|me|v1|mcp)(\/|$)/.test(path)) {
      unexpected.push(call);
      return json({ error: { message: "Unexpected synthetic request" } }, 501);
    }
    return route.continue();
  });
  return {
    writes,
    simulations,
    unexpected,
    setMode(value: Mode) {
      mode = value;
    },
    holdSimulation() {
      hold = true;
      pending = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    releaseSimulation() {
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
      gateway.releaseSimulation();
    }
    expect(gateway.unexpected).toEqual([]);
  },
});
