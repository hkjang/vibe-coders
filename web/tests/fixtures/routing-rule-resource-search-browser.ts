import type { Page } from "@playwright/test";
import { installSearchWorkspace } from "./search-workspace-browser";

export const routingSearchRule = {
  id: "분기/정산?%#",
  enabled: true,
  priority: 10,
  match_pattern: "정산-*",
  min_complexity: 20,
  max_complexity: 80,
  target_model: "정산 분석 모델",
  target_provider: "사내 공급자",
  note: "정산 업무 요청을 검토한 모델로 연결합니다. 실제 선택은 요청 조건과 현재 우선순위에 따라 달라집니다.",
  created_at: "2026-11-13T01:00:00Z",
};
export async function installRoutingRuleResourceSearch(page: Page) {
  const fixture = await installSearchWorkspace(page);
  fixture.bootstrap.backend_version = "v0.86.103";
  const base = fixture.bootstrap.migration_registry[0];
  if (!base || !fixture.bootstrap.user) throw new Error("Missing fixture identity");
  fixture.bootstrap.migration_registry.push({
    ...base,
    feature_id: "routing.rules",
    title: "라우팅 규칙",
    app_path: "/app/routing/rules",
    legacy_path: "/admin#/routing",
    required_permission: "routing:read",
  });
  fixture.bootstrap.allowed_features.push("routing.rules");
  fixture.bootstrap.permissions.push("routing:read");
  fixture.bootstrap.user.scopes = [...(fixture.bootstrap.user.scopes ?? []), "routing:read"];
  fixture.bootstrap.user.features = { ...fixture.bootstrap.user.features, "routing.rules": true };
  const state = { deny: false, failOnce: false, ids: [] as Array<string | null> };
  await page.route("**/admin/routing-rules*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.pathname !== "/admin/routing-rules") return route.fallback();
    if (req.method() !== "GET") {
      fixture.writes.push(req);
      return route.fulfill({ status: 405, json: { error: { message: "unexpected write" } } });
    }
    const id = url.searchParams.get("id");
    state.ids.push(id);
    if (id && state.deny) return route.fulfill({ status: 403, json: { error: { message: "denied" } } });
    if (id && state.failOnce) {
      state.failOnce = false;
      return route.fulfill({
        status: 503,
        json: { error: { message: "unavailable" } },
        headers: { "X-Request-ID": "routing-detail-fixture" },
      });
    }
    return route.fulfill({ json: { rules: !id || id === routingSearchRule.id ? [routingSearchRule] : [] } });
  });
  await page.route("**/admin/resource-search", async (route) => {
    const body = route.request().postDataJSON() as { query: string; kinds: string[] };
    fixture.searches.push(body as (typeof fixture.searches)[number]);
    return route.fulfill({
      json: {
        request_id: "routing-search-fixture",
        groups: body.kinds.map((kind) => ({
          kind,
          status: "ok",
          limited: false,
          items:
            kind === "routing_rule"
              ? [{ kind, id: routingSearchRule.id, title: routingSearchRule.target_model }]
              : [],
        })),
      },
    });
  });
  return { ...fixture, state };
}
