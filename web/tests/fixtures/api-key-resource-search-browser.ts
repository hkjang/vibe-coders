import type { Page } from "@playwright/test";
import { apiKeyPublicSchema } from "../../src/shared/api/domains/access.schemas";
import { installSearchWorkspace } from "./search-workspace-browser";
export const keyFixture = apiKeyPublicSchema.parse({
  id: "key_billing",
  name: "정산 자동화 키",
  owner: "정산 서비스",
  team: "플랫폼",
  role: "developer",
  status: "active",
  scopes: ["chat:completion", "models:read"],
  allowed_ips: ["10.0.0.0/8"],
  allowed_models: ["balanced-*"],
  denied_models: ["legacy-*"],
  allowed_providers: ["사내 공급자"],
  budget_limit_krw: 50000,
  created_at: "2026-11-01T01:00:00Z",
  expires_at: "2027-01-01T00:00:00Z",
});
export async function installAPIKeyResourceSearch(page: Page) {
  const fixture = await installSearchWorkspace(page);
  fixture.bootstrap.backend_version = "v0.86.101";
  const state = { reads: [] as string[], fail: false, denied: false };
  await page.route("**/admin/api-keys*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() !== "GET" || url.pathname !== "/admin/api-keys") {
      fixture.writes.push(request);
      return route.fulfill({ status: 405, json: { error: { message: "unexpected write" } } });
    }
    const id = url.searchParams.get("id");
    state.reads.push(id ?? "list");
    if (id && state.denied)
      return route.fulfill({ status: 403, json: { error: { message: "permission denied" } } });
    if (id && state.fail)
      return route.fulfill({ status: 503, json: { error: { message: "temporary fixture error" } } });
    return route.fulfill({
      json: {
        api_keys: !id || id === keyFixture.id ? [keyFixture] : [],
        revoke_review_supported: true,
        edit_review_supported: true,
      },
    });
  });
  await page.route("**/admin/resource-search", async (route) => {
    const body = route.request().postDataJSON() as { query: string; kinds: string[] };
    fixture.searches.push(body as (typeof fixture.searches)[number]);
    return route.fulfill({
      json: {
        request_id: "key-search-fixture",
        groups: body.kinds.map((kind) => ({
          kind,
          status: "ok",
          limited: false,
          items: kind === "api_key" ? [{ kind, id: keyFixture.id, title: keyFixture.name }] : [],
        })),
      },
    });
  });
  return { ...fixture, state };
}
