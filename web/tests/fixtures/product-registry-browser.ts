import type { Page } from "@playwright/test";
import { installPromptLibrary } from "./prompt-library-browser";

export async function installProductRegistry(page: Page) {
  const fixture = await installPromptLibrary(page, true);
  fixture.bootstrap.backend_version = "v0.86.131";
  const state = { status: 200, empty: false };
  const reads: URLSearchParams[] = [];
  const rows = Array.from({ length: 31 }, (_, index) => ({
    name: index === 0 ? "팀 공통 답변 도우미" : `업무 제품 ${index + 1}`,
    category: "product",
    template_state: index % 3 === 0 ? "enabled" : index % 3 === 1 ? "disabled" : "missing",
    source_requests: index * 12,
    source_distinct_keys: index * 3,
    use_count: index % 3 === 2 ? null : index * 2,
    last_used_at: index % 3 === 2 || index === 0 ? null : "2026-11-16T01:00:00Z",
    created_at: "2026-11-17T03:00:00Z",
  }));
  await page.route("**/admin/prompt-products?*", async (route) => {
    const url = new URL(route.request().url());
    reads.push(url.searchParams);
    if (route.request().method() !== "GET" || url.searchParams.get("view") !== "metadata")
      throw Error("Unexpected product body request");
    if (state.status !== 200)
      return route.fulfill({ status: state.status, json: { error: { message: "private-product-failure" } } });
    const filter = url.searchParams.get("state") ?? "all";
    const limit = Number(url.searchParams.get("limit")),
      offset = Number(url.searchParams.get("offset"));
    const filtered = state.empty
      ? []
      : rows.filter((row) => filter === "all" || row.template_state === filter);
    return route.fulfill({
      json: {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        offset,
        limit,
        state: filter,
        generated_at: "2026-11-17T04:00:00Z",
      },
    });
  });
  return { ...fixture, state, reads, rows };
}
