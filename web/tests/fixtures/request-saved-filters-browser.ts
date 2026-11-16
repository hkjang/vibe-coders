import type { Page } from "@playwright/test";
import { installSettingsWorkspace } from "./settings-workspace-browser";
import { migrationRegistry } from "../../src/config/migration-registry";
import type { AppRequestsResponse } from "../../src/shared/api/generated";
import type { SavedFilter } from "../../src/shared/api/domains/observability.schemas";

export async function installRequestSavedFilters(page: Page) {
  const fixture = await installSettingsWorkspace(page);
  const bootstrap = fixture.bootstrap;
  const base = bootstrap.migration_registry[0];
  const feature = migrationRegistry.find((item) => item.featureId === "observability.requests");
  if (!base || !feature || !bootstrap.user) throw new Error("Missing request fixture identity");
  bootstrap.backend_version = "v0.86.117";
  bootstrap.ui.default_entry = feature.appPath;
  bootstrap.migration_registry = [
    {
      ...base,
      feature_id: feature.featureId,
      title: feature.title,
      app_path: feature.appPath,
      legacy_path: feature.legacyPath,
      status: "preview",
      read_only: false,
      minimum_api_version: feature.minimumApiVersion,
    },
  ];
  bootstrap.allowed_features = [feature.featureId];
  bootstrap.user.features = { [feature.featureId]: true };
  const state = {
    filterReads: 0,
    queryReads: [] as URLSearchParams[],
    failRead: false,
    filters: [
      {
        id: "filt_ops",
        name: "운영 모델의 서버 오류",
        view: "requests",
        params: "model=production-chat&status=5xx&limit=25&tz=Asia%2FSeoul",
        created_by: "another-admin",
        created_at: "2026-11-16T00:00:00Z",
      },
    ] as SavedFilter[],
  };
  await page.route("**/admin/requests?*", (route) => {
    state.queryReads.push(new URL(route.request().url()).searchParams);
    return route.fulfill({
      json: { requests: [], limit: 25, generated_at: "2026-11-16T01:00:00Z" } satisfies AppRequestsResponse,
    });
  });
  await page.route("**/admin/saved-filters**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") {
      state.filterReads++;
      if (state.failRead)
        return route.fulfill({
          status: 503,
          headers: { "X-Request-ID": "shared-filter-fixture" },
          json: { error: { message: "unavailable" } },
        });
      return route.fulfill({ json: { filters: state.filters } });
    }
    fixture.writes.push(request);
    if (request.method() === "POST") {
      const body = request.postDataJSON() as { name: string; params: string; view: string };
      const filter = {
        ...body,
        id: `filt_${fixture.writes.length}`,
        created_by: "current-admin",
        created_at: "2026-11-16T01:00:00Z",
      };
      state.filters.push(filter);
      return route.fulfill({ status: 201, json: { filter } });
    }
    const id = url.pathname.split("/").at(-1);
    const filter = state.filters.find((item) => item.id === id);
    if (!filter) return route.fulfill({ status: 404, json: {} });
    if (request.method() === "PATCH") {
      const body = request.postDataJSON() as { name: string };
      filter.name = body.name;
      return route.fulfill({ json: { filter } });
    }
    if (request.method() === "DELETE") {
      state.filters = state.filters.filter((item) => item.id !== id);
      return route.fulfill({ json: { id, status: "deleted" } });
    }
    return route.fulfill({ status: 405, json: {} });
  });
  await page.clock.setFixedTime(new Date("2026-11-16T01:00:00Z"));
  return { ...fixture, state };
}
