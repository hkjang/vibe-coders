import { expect, test as base } from "@playwright/test";
import type { UiBootstrapResponse } from "../../../src/shared/api/generated";
import type { MigrationStatus } from "../../../src/config/migration-registry";

export const account = {
  id: "public-sql-operator",
  email: "sql-operator@example.invalid",
  name: "공개 SQL 운영자",
  role: "admin",
  roles: ["admin"],
  scopes: ["admin:read", "admin:write"],
};
export const reason = "공개 검증용 처리 변경 사유";
export const test = base.extend<{
  emergency: {
    writes: unknown[];
    readonly: (value: boolean) => void;
    migrationStatus: (value: MigrationStatus) => void;
    failOverview: (value: boolean) => void;
    failRead: (value: boolean) => void;
    denyWrite: () => void;
    refreshes: () => number;
  };
}>({
  emergency: async ({ context, baseURL }, run) => {
    if (!baseURL) throw new Error("Expected synthetic origin");
    const origin = new URL(baseURL).origin;
    let authenticated = false;
    let readOnly = false;
    let migrationStatus: MigrationStatus = "preview";
    let overviewUnavailable = false;
    let unavailable = false;
    let denied = false;
    let disabled = false;
    let revision = 1;
    let refreshes = 0;
    const writes: unknown[] = [];
    const unexpected: string[] = [];
    const state = () => ({
      disabled,
      config_enabled: true,
      scope: "responding_process",
      instance_ref: "process_0123456789abcdef",
      observed_at: "2026-10-12T04:00:00Z",
      review_token: revision.toString(16).padStart(32, "0"),
    });
    const bootstrap = (): UiBootstrapResponse => ({
      backend_version: "v0.86.50",
      ui_version: "synthetic-text2sql-emergency",
      api_version: "v1",
      ui: {
        enabled: true,
        default_entry: "/app/text2sql",
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
      },
      ...(authenticated ? { user: account } : {}),
      roles: authenticated ? account.roles : [],
      permissions: authenticated ? account.scopes : [],
      capabilities: { raw_prompt_view: false },
      allowed_features: authenticated ? ["text2sql.overview"] : [],
      migration_registry: [
        {
          feature_id: "text2sql.overview",
          title: "자연어 SQL 운영",
          app_path: "/app/text2sql",
          legacy_path: "/admin#/text2sql",
          status: migrationStatus,
          risk_level: "high",
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
      legacy_route_map: { "/app/text2sql": "/admin#/text2sql" },
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const call = `${request.method()} ${url.pathname}`;
      const reply = (json: unknown, status = 200) =>
        route.fulfill({
          status,
          json,
          headers: { "Cache-Control": "no-store", "X-Request-ID": "public-sql-review" },
        });
      if (url.origin !== origin) {
        unexpected.push("external request");
        return route.abort("blockedbyclient");
      }
      if (call === "POST /auth/login") {
        expect(request.postDataJSON()).toEqual({ email: account.email, password: "public-password" });
        authenticated = true;
        return reply({
          access_token: "public-sql-access",
          refresh_token: "public-sql-refresh",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_expires_in: 7200,
          user: account,
        });
      }
      if (call === "GET /admin/ui-bootstrap") return reply(bootstrap());
      if (call === "GET /health" || call === "GET /ready") return reply({ status: "ok" });
      if (call === "GET /auth/me") return reply({ user: account, scopes: account.scopes });
      if (call === "POST /auth/refresh") {
        refreshes++;
        return reply({ error: { message: "Refresh must not replay a change" } }, 401);
      }
      if (url.pathname.startsWith("/admin/")) {
        expect(request.headers().authorization).toBe("Bearer public-sql-access");
        if (call === "GET /admin/text2sql/kill-switch") {
          return unavailable ? reply({ error: { code: "state_unavailable" } }, 503) : reply(state());
        }
        if (call === "POST /admin/text2sql/kill-switch") {
          const body: unknown = request.postDataJSON();
          writes.push(body);
          expect(request.headers()["x-vibe-route"]).toBe("text2sql.overview");
          if (denied) return reply({ error: { code: "unauthorized" } }, 401);
          expect(body).toEqual({ disabled: !disabled, reason, expected_review_token: state().review_token });
          disabled = !disabled;
          revision++;
          return reply({ ...state(), reason });
        }
        if (call === "GET /admin/text2sql" && overviewUnavailable)
          return reply({ error: { code: "state_unavailable" } }, 503);
        if (call === "GET /admin/text2sql")
          return reply({
            enabled: true,
            stats: {},
            profiles: [],
            db_profiles: [],
            schemas: [],
            permissions: [],
            golden: [],
            logs: [],
            failures: [],
            model_metrics: [],
            stage_metrics: [],
          });
        if (call === "GET /admin/text2sql/connections") return reply({ connections: [] });
      }
      if (url.pathname.startsWith("/app/") || url.pathname === "/favicon.ico") return route.continue();
      unexpected.push(call);
      return reply({ error: { message: "Unexpected synthetic request" } }, 501);
    });
    await run({
      writes,
      readonly: (value) => {
        readOnly = value;
      },
      migrationStatus: (value) => {
        migrationStatus = value;
      },
      failOverview: (value) => {
        overviewUnavailable = value;
      },
      failRead: (value) => {
        unavailable = value;
      },
      denyWrite: () => {
        denied = true;
      },
      refreshes: () => refreshes,
    });
    expect(unexpected).toEqual([]);
  },
});
