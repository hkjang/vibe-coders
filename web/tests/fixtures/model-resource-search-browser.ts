import type { Page } from "@playwright/test";
import { installSearchWorkspace } from "./search-workspace-browser";
export const modelName = "정산 모델";
export const alphaRef = `prv_${"a".repeat(43)}`,
  betaRef = `prv_${"b".repeat(43)}`;
export async function installModelResourceSearch(page: Page) {
  const fixture = await installSearchWorkspace(page);
  fixture.bootstrap.backend_version = "v0.86.102";
  const base = fixture.bootstrap.migration_registry[0];
  if (!base || !fixture.bootstrap.user) throw new Error("Missing fixture identity");
  fixture.bootstrap.migration_registry.push({
    ...base,
    feature_id: "gateway.models",
    title: "모델",
    app_path: "/app/gateway/models",
    legacy_path: "/admin#/model-contracts",
    required_permission: "admin:read",
  });
  fixture.bootstrap.allowed_features.push("gateway.models");
  fixture.bootstrap.user.features = { ...fixture.bootstrap.user.features, "gateway.models": true };
  const state = { partial: true, fail: false, reads: [] as string[] };
  const timestamp = "2026-11-13T01:00:00Z";
  const models = [
    { provider: "사내 공급자", provider_ref: alphaRef },
    { provider: "보조 공급자", provider_ref: betaRef },
  ].map((provider) => ({
    ...provider,
    id: modelName,
    object: "model",
    owned_by: "공급자",
    created: 1700000000,
    source: "live",
    virtual: false,
    shadowed: false,
    shadowed_by: "",
    stale: false,
    fetched_at: timestamp,
    deprecation: null,
  }));
  const catalogue = {
    request_id: "model-detail-fixture",
    generated_at: timestamp,
    models,
    partial_failures: [],
    providers: models.map((model) => ({
      provider: model.provider,
      provider_ref: model.provider_ref,
      status: "ok",
      source: "live",
      stale: false,
      model_count: 1,
      fetched_at: timestamp,
    })),
  };
  for (const path of [
    "/admin/models",
    "/admin/models/quality",
    "/admin/model-tags",
    "/admin/models/contracts",
    "/admin/pricing",
  ]) {
    await page.route(`**${path}*`, async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.pathname !== path) return route.fallback();
      if (request.method() !== "GET") {
        fixture.writes.push(request);
        return route.fulfill({ status: 405, json: { error: { message: "unexpected write" } } });
      }
      state.reads.push(path);
      return route.fulfill({
        json:
          path === "/admin/models"
            ? catalogue
            : path === "/admin/models/quality"
              ? { categories: [], since: timestamp, models: [] }
              : path === "/admin/pricing"
                ? { effective: {}, versions: [] }
                : path === "/admin/model-tags"
                  ? { tags: [] }
                  : { contracts: [] },
      });
    });
  }
  await page.route("**/admin/resource-search", async (route) => {
    const body = route.request().postDataJSON() as { query: string; kinds: string[] };
    fixture.searches.push(body as (typeof fixture.searches)[number]);
    return route.fulfill({
      json: {
        request_id: "model-search-fixture",
        groups: body.kinds.map((kind) => ({
          kind,
          status: kind === "model" ? (state.fail ? "unavailable" : state.partial ? "partial" : "ok") : "ok",
          limited: false,
          items:
            kind === "model" && !state.fail
              ? models.map((model) => ({
                  kind,
                  id: model.id,
                  title: model.id,
                  provider_ref: model.provider_ref,
                  provider_label: model.provider,
                }))
              : [],
        })),
      },
    });
  });
  return { ...fixture, state };
}
