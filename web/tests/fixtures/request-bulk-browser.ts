import type { Page } from "@playwright/test";
import type { AppRequestsResponse } from "../../src/shared/api/generated";
import { installRequestSavedFilters } from "./request-saved-filters-browser";
import { flowRequestA } from "../e2e/fixtures/request-safe-flow";

export async function installRequestBulk(page: Page) {
  const fixture = await installRequestSavedFilters(page);
  fixture.bootstrap.backend_version = "v0.86.123";
  fixture.bootstrap.permissions = ["admin:read"];
  if (fixture.bootstrap.user) fixture.bootstrap.user.scopes = ["admin:read"];
  for (const feature of fixture.bootstrap.migration_registry) feature.read_only = true;
  const rows = [1, 2, 3, 4].map((index) => ({
    ...flowRequestA,
    request_id: `요청-${index}`,
    request_ref: `req_${"a".repeat(22)}.${String(index).repeat(21)}`,
    model: index === 3 ? "=1+1" : `공개 모델 ${index}`,
    estimated_cost: index * 0.0004,
  }));
  const bulk = { reads: 0, status: 200, empty: false };
  const next = `djE6cmVxdWVzdC1uZXh0.${"n".repeat(43)}`;
  const previous = `djE6cmVxdWVzdC1wcmV2aW91cw.${"p".repeat(43)}`;
  await page.route("**/admin/requests?*", async (route) => {
    if (route.request().method() !== "GET") {
      fixture.writes.push(route.request());
      return route.fulfill({ status: 405, json: {} });
    }
    bulk.reads++;
    if (bulk.status !== 200)
      return route.fulfill({
        status: bulk.status,
        headers: { "X-Request-ID": "request-bulk-fixture" },
        json: { error: { message: "synthetic unavailable" } },
      });
    const last = new URL(route.request().url()).searchParams.get("cursor") === next;
    return route.fulfill({
      json: {
        requests: bulk.empty ? [] : last ? rows.slice(3) : rows.slice(0, 3),
        limit: 25,
        generated_at: "2026-11-16T01:00:00Z",
        ...(last ? { previous_cursor: previous } : { next_cursor: next }),
      } satisfies AppRequestsResponse,
    });
  });
  return { ...fixture, bulk };
}
