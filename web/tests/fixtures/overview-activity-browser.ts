import type { Page } from "@playwright/test";
import { migrationRegistry } from "../../src/config/migration-registry";
import { installOverviewWorkspace } from "./overview-workspace-browser";
import { alertActivity, auditActivity, incidentActivity } from "./activity-summaries";

export async function installOverviewActivity(page: Page) {
  const fixture = await installOverviewWorkspace(page);
  const bootstrap = fixture.bootstrap;
  const base = bootstrap.migration_registry[0];
  if (!base || !bootstrap.user) throw new Error("Missing activity fixture identity");
  bootstrap.backend_version = "v0.86.129";
  bootstrap.permissions.push("security:read");
  for (const id of ["governance.policies", "system.settings"]) {
    const feature = migrationRegistry.find((f) => f.featureId === id);
    if (!feature) throw new Error("Missing activity feature");
    bootstrap.migration_registry.push({
      ...base,
      feature_id: id,
      title: feature.title,
      app_path: feature.appPath,
      legacy_path: feature.legacyPath,
      required_permission: feature.requiredPermission ?? "admin:read",
      read_only: true,
    });
    bootstrap.allowed_features.push(id);
    bootstrap.user.features = { ...bootstrap.user.features, [id]: true };
  }
  const state = {
    detailReads: [] as string[],
    alertStatus: 200,
    empty: false,
    reads: [] as { path: string; window: string }[],
  };
  await page.route("**/admin/**", async (route) => {
    const url = new URL(route.request().url());
    if (["/admin/audit-logs", "/admin/audit/auth-events"].includes(url.pathname)) {
      state.detailReads.push(url.pathname);
      if (route.request().method() !== "GET") {
        fixture.writes.push(route.request());
        return route.fulfill({ status: 405, json: {} });
      }
      return route.fulfill({
        status: 200,
        json: url.pathname === "/admin/audit-logs" ? { audit_logs: [] } : { events: [] },
      });
    }

    if (
      !["/admin/incidents/summary", "/admin/alerts/summary", "/admin/audit-logs/summary"].includes(
        url.pathname,
      )
    )
      return route.fallback();
    state.reads.push({ path: url.pathname, window: url.searchParams.get("window") ?? "" });
    if (route.request().method() !== "GET") {
      fixture.writes.push(route.request());
      return route.fulfill({ status: 405, json: {} });
    }
    const alerts = url.pathname === "/admin/alerts/summary";
    if (alerts && state.alertStatus !== 200)
      return route.fulfill({
        status: state.alertStatus,
        json: { error: { message: "private-activity-detail" } },
        headers: { "X-Request-ID": "activity-request" },
      });
    const data = alerts
      ? { ...alertActivity, ...(state.empty ? { events: [], has_more: false } : {}) }
      : url.pathname === "/admin/incidents/summary"
        ? { ...incidentActivity, ...(state.empty ? { signals: [], total: 0, current_hour: 0 } : {}) }
        : { ...auditActivity, ...(state.empty ? { changes: [], has_more: false } : {}) };
    return route.fulfill({ status: 200, json: { ...data, window: url.searchParams.get("window") } });
  });
  return { ...fixture, activity: state };
}
