import type { Page } from "@playwright/test";
import { installPromptLibrary } from "./prompt-library-browser";

export async function installContextRegistry(page: Page) {
  const fixture = await installPromptLibrary(page, true);
  fixture.bootstrap.backend_version = "v0.86.130";
  const state = { status: 200, empty: false };
  const reads: URLSearchParams[] = [];
  const rows = Array.from({ length: 31 }, (_, index) => ({
    key: `reference-${String(index + 1).padStart(2, "0")}`,
    name: index === 0 ? "팀 공통 작성 지침" : `업무 참고자료 ${index + 1}`,
    enabled: index % 2 === 0,
    token_estimate: index === 1 ? null : 128 + index,
    use_count: index * 3,
    last_used_at: index === 0 ? null : "2026-11-16T01:00:00Z",
    updated_at: "2026-11-17T03:00:00Z",
  }));
  await page.route("**/admin/contexts?*", async (route) => {
    const url = new URL(route.request().url());
    reads.push(url.searchParams);
    if (route.request().method() !== "GET" || url.searchParams.get("view") !== "metadata")
      throw Error("Unexpected context body request");
    if (state.status !== 200)
      return route.fulfill({ status: state.status, json: { error: { message: "private-context-failure" } } });
    const filter = url.searchParams.get("state") ?? "all";
    const limit = Number(url.searchParams.get("limit")),
      offset = Number(url.searchParams.get("offset"));
    const filtered = state.empty
      ? []
      : rows.filter((row) => filter === "all" || row.enabled === (filter === "enabled"));
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
