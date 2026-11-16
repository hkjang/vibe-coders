import type { Page } from "@playwright/test";
import { installSearchWorkspace } from "./search-workspace-browser";
export const searchedSchema = {
  name: "정산/서울?%#",
  team: "재무 운영 팀",
  dialect: "postgres",
  enabled: false,
  is_default: true,
  schema_text:
    "정산 내역과 부서별 예산을 설명하는 검토된 스키마입니다. 실제 실행은 별도 권한 검사 후 진행합니다.",
  allowed_tables: ["정산_내역", "부서별_예산"],
  version: 4,
  collected_at: "",
  source_fingerprint: "billing-v4",
  updated_at: "",
};
export async function installSchemaSearch(page: Page) {
  const fixture = await installSearchWorkspace(page);
  fixture.bootstrap.backend_version = "v0.86.107";
  const base = fixture.bootstrap.migration_registry[0];
  if (!base || !fixture.bootstrap.user) throw new Error("Missing fixture identity");
  fixture.bootstrap.migration_registry.push({
    ...base,
    feature_id: "text2sql.overview",
    title: "Text2SQL 운영",
    app_path: "/app/text2sql",
    legacy_path: "/admin#/text2sql",
    required_permission: "admin:read",
  });
  fixture.bootstrap.allowed_features.push("text2sql.overview");
  fixture.bootstrap.user.features = { ...fixture.bootstrap.user.features, "text2sql.overview": true };
  const state = { deny: false, missing: false, failOnce: false, raw: false, names: [] as string[] };
  await page.route("**/admin/text2sql?*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() !== "GET") {
      fixture.writes.push(request);
      return route.fulfill({ status: 405, json: {} });
    }
    const name = url.searchParams.get("name");
    if (url.searchParams.get("view") !== "schema" || !name) {
      fixture.unexpected.push(request.url());
      return route.fulfill({ status: 400, json: {} });
    }
    state.names.push(name);
    if (state.deny) return route.fulfill({ status: 403, json: { error: { message: "denied" } } });
    if (state.missing || name !== searchedSchema.name)
      return route.fulfill({ status: 404, json: { error: { message: "missing" } } });
    if (state.failOnce) {
      state.failOnce = false;
      return route.fulfill({
        status: 503,
        json: { error: { message: "unavailable" } },
        headers: { "X-Request-ID": "schema-detail-fixture" },
      });
    }
    return route.fulfill({
      json: {
        schema: {
          ...searchedSchema,
          schema_text: state.raw ? searchedSchema.schema_text : "[sensitive-content-omitted]",
          allowed_tables: state.raw ? searchedSchema.allowed_tables : [],
        },
        raw_content_available: state.raw,
      },
    });
  });
  await page.route("**/admin/resource-search", async (route) => {
    const body = route.request().postDataJSON() as { query: string; kinds: string[] };
    fixture.searches.push(body as (typeof fixture.searches)[number]);
    return route.fulfill({
      json: {
        request_id: "schema-search-fixture",
        groups: body.kinds.map((kind) => ({
          kind,
          status: "ok",
          limited: false,
          items:
            kind === "text2sql_schema" ? [{ kind, id: searchedSchema.name, title: searchedSchema.name }] : [],
        })),
      },
    });
  });
  return { ...fixture, state };
}
