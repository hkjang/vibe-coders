import type { Page } from "@playwright/test";
import { migrationRegistry } from "../../src/config/migration-registry";
import { installOverviewWorkspace } from "./overview-workspace-browser";
import { mcpSummary, text2sqlSummary } from "./service-summaries";

export async function installOverviewServices(page: Page) {
  const fixture = await installOverviewWorkspace(page);
  const bootstrap = fixture.bootstrap;
  const base = bootstrap.migration_registry[0];
  if (!base || !bootstrap.user) throw new Error("Missing summary fixture identity");
  bootstrap.backend_version = "v0.86.128";
  for (const id of ["mcp.overview", "text2sql.overview"]) {
    const feature = migrationRegistry.find((f) => f.featureId === id);
    if (!feature) throw new Error("Missing summary feature");
    bootstrap.migration_registry.push({
      ...base,
      feature_id: id,
      title: feature.title,
      app_path: feature.appPath,
      legacy_path: feature.legacyPath,
      required_permission: "admin:read",
      read_only: true,
    });
    bootstrap.allowed_features.push(id);
    bootstrap.user.features = { ...bootstrap.user.features, [id]: true };
  }
  const state = {
    mcpStatus: 200,
    textStatus: 200,
    empty: false,
    reads: [] as string[],
    windows: [] as string[],
  };
  await page.route("**/admin/**", async (route) => {
    const url = new URL(route.request().url());
    if (!["/admin/mcp/overview", "/admin/text2sql/summary"].includes(url.pathname)) return route.fallback();
    state.reads.push(url.pathname);
    if (route.request().method() !== "GET") {
      fixture.writes.push(route.request());
      return route.fulfill({ status: 405, json: {} });
    }
    const mcp = url.pathname === "/admin/mcp/overview";
    const status = mcp ? state.mcpStatus : state.textStatus;
    if (!mcp) state.windows.push(url.searchParams.get("window") ?? "");
    if (status !== 200)
      return route.fulfill({
        status,
        json: { error: { message: "private-service-detail" } },
        headers: { "X-Request-ID": "summary-request" },
      });
    const json = mcp
      ? state.empty
        ? {
            ...mcpSummary,
            upstream_count: 0,
            enabled_upstream_count: 0,
            healthy_upstream_count: 0,
            total_tools: 0,
            recent_call_count: 0,
            recent_error_count: 0,
            discovery_error_count: 0,
            fetched_at: "0001-01-01T00:00:00Z",
          }
        : mcpSummary
      : {
          ...text2sqlSummary,
          window: url.searchParams.get("window"),
          ...(state.empty
            ? { stats: { total: 0, valid: 0, executed: 0, errors: 0, cost_krw: 0, valid_rate: 0 } }
            : {}),
        };
    return route.fulfill({ status, json });
  });
  return { ...fixture, services: state };
}
