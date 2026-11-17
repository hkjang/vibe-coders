import type { Page } from "@playwright/test";
import { installContextRegistry } from "./context-registry-browser";
export async function installContextSearch(page: Page) {
  const fixture = await installContextRegistry(page);
  fixture.bootstrap.backend_version = "v0.86.134";
  fixture.rows.push({
    key: "literal%_!",
    name: "특수 검색 참고자료",
    enabled: true,
    token_estimate: 600,
    use_count: 999,
    last_used_at: null,
    updated_at: "2026-11-17T03:00:00Z",
  });
  await page.route("**/admin/contexts?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    fixture.reads.push(params);
    if (route.request().method() !== "GET" || params.get("view") !== "metadata")
      throw new Error("Unexpected context content request");
    if (fixture.state.status !== 200)
      return route.fulfill({
        status: fixture.state.status,
        json: { error: { message: "private-context-failure" } },
      });
    const state = params.get("state") ?? "all",
      q = (params.get("q") ?? "").toLowerCase();
    const limit = Number(params.get("limit")),
      offset = Number(params.get("offset"));
    const filtered = fixture.state.empty
      ? []
      : fixture.rows.filter(
          (row) =>
            (state === "all" || row.enabled === (state === "enabled")) &&
            (row.name.toLowerCase().includes(q) || row.key.toLowerCase().includes(q)),
        );
    const sort = params.get("sort") ?? "key:asc";
    filtered.sort((a, b) => {
      for (const pair of sort.split(",")) {
        const [field, direction] = pair.split(":");
        if (
          field !== "key" &&
          field !== "name" &&
          field !== "enabled" &&
          field !== "token_estimate" &&
          field !== "use_count"
        )
          throw new Error("Unsupported fixture sort");
        const x = a[field],
          y = b[field];
        if (x === null || y === null) {
          if (x === y) continue;
          return x === null ? 1 : -1;
        }
        const value =
          typeof x === "string" && typeof y === "string" ? x.localeCompare(y, "en") : Number(x) - Number(y);
        if (value !== 0) return direction === "desc" ? -value : value;
      }
      return a.key.localeCompare(b.key, "en");
    });
    return route.fulfill({
      json: {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        limit,
        offset,
        state,
        generated_at: "2026-11-17T04:00:00Z",
      },
    });
  });
  return fixture;
}
