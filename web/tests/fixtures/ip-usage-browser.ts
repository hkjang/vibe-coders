import { expect, type Page } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";
import { ipFixture, ipDetailFixture } from "../../src/test/ip-usage";

export async function installIpUsage(page: Page, requestAccess = true) {
  const user = {
    id: "ip-public-viewer",
    name: "운영 조회자",
    email: "viewer@example.invalid",
    role: "viewer",
    roles: ["viewer"],
    team_id: "public-team",
    scopes: ["admin:read", ...(requestAccess ? ["observability:read"] : [])],
  };
  const features = [
    {
      feature_id: "access.users",
      title: "사용자와 팀",
      app_path: "/app/access/users",
      legacy_path: "/admin#/users",
      required_permission: "admin:read",
    },
    ...(requestAccess
      ? [
          {
            feature_id: "observability.requests",
            title: "요청 탐색기",
            app_path: "/app/observability/requests",
            legacy_path: "/admin#/requests",
            required_permission: "observability:read",
          },
        ]
      : []),
  ];
  const bootstrap: UiBootstrapResponse = {
    backend_version: "v0.86.73",
    ui_version: "public-ip-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/access/users",
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
      credential_prefixes: ["corp_"],
    },
    user,
    roles: user.roles,
    permissions: user.scopes,
    capabilities: { raw_prompt_view: false },
    allowed_features: features.map((feature) => feature.feature_id),
    migration_registry: features.map((feature) => ({
      ...feature,
      status: "preview_read_only",
      risk_level: "medium",
      read_only: true,
      enabled_roles: [],
      rollout_percent: 100,
      fallback_enabled: true,
      minimum_api_version: "v0.84.0",
      available: true,
    })),
    system_status: { status: "healthy" },
    legacy_route_map: {},
  };
  const state = {
    ips: [
      ipFixture(),
      ...Array.from({ length: 24 }, (_, index) => ipFixture("192.0.2." + (index + 1), 24 - index)),
      ipFixture("unknown", 0),
    ],
    listStatus: 200,
    detailStatus: 200,
    detail: ipDetailFixture(),
  };
  const reads: string[] = [],
    unexpected: string[] = [],
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.name));
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    if (path.startsWith("/app/")) return route.continue();
    const json = (value: unknown, status = 200) =>
      route.fulfill({ json: value, status, headers: { "Cache-Control": "no-store" } });
    if (path === "/auth/me") return json({ authenticated: true, user });
    if (path === "/admin/ui-bootstrap") return json(bootstrap);
    if (path === "/health") return json({ status: "ok" });
    if (request.method() === "GET" && path === "/admin/roles") return json({ roles: [] });
    if (request.method() === "GET" && path === "/admin/ips") {
      reads.push(path);
      return state.listStatus === 200
        ? json({ ips: state.ips })
        : json({ error: { message: "public fixture failure" } }, state.listStatus);
    }
    if (request.method() === "GET" && path.startsWith("/admin/ips/")) {
      reads.push(path + url.search);
      const ip = decodeURIComponent(path.slice("/admin/ips/".length));
      return state.detailStatus === 200
        ? json({ ...state.detail, stats: { ...state.detail.stats, ip } })
        : json({ error: { message: "public fixture failure" } }, state.detailStatus);
    }
    unexpected.push(request.method() + " " + path);
    return json({ error: { message: "unexpected fixture request" } }, 500);
  });
  return {
    state,
    reads,
    check: () => {
      expect(unexpected).toEqual([]);
      expect(errors).toEqual([]);
    },
  };
}
