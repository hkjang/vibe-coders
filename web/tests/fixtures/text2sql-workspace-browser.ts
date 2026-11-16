import type { Page } from "@playwright/test";
import { installSettingsWorkspace } from "./settings-workspace-browser";
import { migrationRegistry } from "../../src/config/migration-registry";
import { workspaceOverview } from "../../src/features/text2sql/overview/text2sql-workspace-fixture";

export async function installText2SqlWorkspace(page: Page, health?: Record<string, unknown>) {
  const fixture = await installSettingsWorkspace(page, "admin");
  const bootstrap = fixture.bootstrap;
  const base = bootstrap.migration_registry[0];
  if (!base || !bootstrap.user) throw new Error("Missing fixture identity");
  bootstrap.backend_version = "v0.86.109";
  bootstrap.ui.default_entry = "/app/text2sql";
  bootstrap.migration_registry = migrationRegistry
    .filter((feature) => feature.featureId === "text2sql.overview")
    .map((feature) => ({
      ...base,
      feature_id: feature.featureId,
      title: feature.title,
      app_path: feature.appPath,
      legacy_path: feature.legacyPath,
      read_only: false,
      status: "preview",
    }));
  bootstrap.allowed_features = ["text2sql.overview"];
  bootstrap.user.features = { "text2sql.overview": true };
  bootstrap.user.scopes = bootstrap.permissions = ["admin:read", "admin:write"];
  const state = { reads: {} as Record<string, number>, deny: "", fail: "", holdExport: false };
  let releaseExport = () => {};
  const exportWait = new Promise<void>((resolve) => {
    releaseExport = resolve;
  });
  const bodies: Record<string, unknown> = {
    "/admin/text2sql": workspaceOverview,
    "/admin/text2sql/kill-switch": { disabled: false, config_enabled: true },
    "/admin/text2sql/connections": {
      connections: [
        {
          id: "analytics_db",
          name: "분석 DB",
          driver: "postgres",
          description: "읽기 전용 분석 연결",
          enabled: true,
        },
      ],
    },
    "/admin/text2sql/features": {
      features: [{ name: "explain", description: "SQL 실행 계획 점검", enabled: true }],
    },
    "/admin/text2sql/glossary": { terms: [], conflicts: [] },
    "/admin/text2sql/tables": { tables: [], columns: [] },
    "/admin/text2sql/risk-queue": { count: 0, queue: [] },
    "/admin/text2sql/anomalies": {
      detection_only: true,
      usage_smells: [],
      risk_exposure: [],
      intent_drifts: [],
    },
    "/admin/text2sql/miners": { report_candidates: [], glossary_candidates: [] },
    "/admin/text2sql/reports": { reports: [] },
    "/admin/text2sql/registry/export": {
      version: 1,
      schema: "analytics",
      tables: [{ schema_name: "analytics", table_name: "orders", description: "주문", enabled: true }],
      columns: [],
    },
    "/admin/text2sql/healthcheck": health ?? {
      status: "ok",
      detail: "읽기 전용 연결 정상",
      read_only_tx_ok: true,
      account_write_restricted: true,
      driver: "postgres",
    },
  };
  await page.route("**/admin/text2sql**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      fixture.writes.push(request);
      if (path === "/admin/text2sql/registry/import")
        return route.fulfill({
          json: { tables_imported: 1, columns_imported: 0, table_errors: 0, column_errors: 0 },
        });
      return route.fulfill({ status: 405, json: { error: { message: "unexpected write" } } });
    }
    if (!(path in bodies)) {
      fixture.unexpected.push(path);
      return route.fulfill({ status: 404, json: {} });
    }
    state.reads[path] = (state.reads[path] ?? 0) + 1;
    if (path === state.deny || path === state.fail)
      return route.fulfill({
        status: path === state.deny ? 403 : 503,
        json: { error: { message: "fixture unavailable" } },
        headers: { "X-Request-ID": "text2sql-workspace-fixture" },
      });
    if (path === "/admin/text2sql/registry/export" && state.holdExport) await exportWait;
    return route.fulfill({ json: bodies[path] });
  });
  await page.clock.setFixedTime(new Date("2026-11-01T04:00:00Z"));
  return { ...fixture, state, releaseExport };
}
