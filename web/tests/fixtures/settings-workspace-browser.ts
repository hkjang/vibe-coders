import type { Page, Request } from "@playwright/test";
import type { EffectiveSetting } from "../../src/shared/api/domains/system.schemas";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

const initialBootstrap: UiBootstrapResponse = {
  backend_version: "v0.86.6",
  ui_version: "e2e-v0.86.6",
  api_version: "v1",
  ui: {
    enabled: true,
    default_entry: "/app/system/settings",
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
  user: {
    id: "rollout-e2e-admin",
    email: "rollout@example.invalid",
    name: "콘솔 운영자",
    role: "admin",
    roles: ["admin"],
    team_id: "platform",
    scopes: ["admin:read", "admin:write"],
    features: { "system.settings": true },
  },
  capabilities: { raw_prompt_view: false },
  roles: ["admin"],
  permissions: ["admin:read", "admin:write"],
  allowed_features: ["system.settings"],
  migration_registry: [
    {
      feature_id: "system.settings",
      title: "시스템 설정",
      app_path: "/app/system/settings",
      legacy_path: "/admin#/settings",
      status: "preview",
      risk_level: "critical",
      required_permission: "admin:read",
      read_only: false,
      enabled_roles: ["admin"],
      rollout_percent: 100,
      fallback_enabled: true,
      minimum_api_version: "v0.86.6",
      available: true,
    },
  ],
  system_status: { status: "healthy" },
  legacy_route_map: { "/app/system/settings": "/admin#/settings" },
};

export const runtimeKey = "cache.chat_enabled";
export async function installSettingsWorkspace(page: Page, role = "admin") {
  const bootstrap = structuredClone(initialBootstrap);
  if (!bootstrap.user) throw new Error("Fixture account missing");
  bootstrap.user.role = role;
  bootstrap.user.roles = [role];
  bootstrap.roles = [role];
  bootstrap.user.scopes = role === "admin" ? ["admin:read", "admin:write"] : ["admin:read"];
  bootstrap.permissions = bootstrap.user.scopes;
  bootstrap.backend_version = "v0.86.98";
  for (const feature of bootstrap.migration_registry) feature.enabled_roles = [role];
  const state = {
    denied: false,
    failOnce: false,
    writes: [] as Request[],
    unexpected: [] as string[],
    reads: 0,
    settings: [
      {
        key: runtimeKey,
        category: "cache",
        type: "bool",
        description: "동일한 채팅 요청의 응답 캐시 사용 여부입니다.",
        value: "true",
        source: "admin",
        version: 3,
        can_write: role === "admin" || role === "ops_admin",
        permission_group: "ops",
        is_secret: false,
        is_set: true,
        read_only: false,
        restart_required: false,
        updated_at: "2026-11-01T00:00:00Z",
      },
    ] as EffectiveSetting[],
  };
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      call = `${request.method()} ${url.pathname}`;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, json: body, headers: { "X-Request-ID": "settings-workspace-fixture" } });
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap);
    if (call === "GET /health") return json({ status: "ok" });
    if (call === "GET /ready") return json({ status: "ready" });
    if (call === "GET /admin/settings/effective") {
      state.reads++;
      if (state.denied) return json({ error: { message: "permission denied" } }, 403);
      if (state.failOnce) {
        state.failOnce = false;
        return json({ error: { message: "temporarily unavailable" } }, 503);
      }
      return json({ settings: state.settings });
    }
    if (call === "GET /admin/settings/history") return json({ history: [] });
    if (call === `PUT /admin/settings/by-key/${runtimeKey}`) {
      state.writes.push(request);
      const row = state.settings[0];
      if (!row?.can_write) return json({ error: { message: "permission denied" } }, 403);
      const body = request.postDataJSON() as { value: string; expected_version: number };
      if (body.expected_version !== row.version) return json({ error: { code: "setting_conflict" } }, 409);
      state.settings = [{ ...row, value: body.value, version: (row.version ?? 0) + 1 }];
      return json(state.settings[0]);
    }
    if (url.pathname.startsWith("/admin/")) {
      state.unexpected.push(call);
      return json({ error: { message: "unexpected fixture call" } }, 501);
    }
    await route.continue();
  });
  return state;
}
