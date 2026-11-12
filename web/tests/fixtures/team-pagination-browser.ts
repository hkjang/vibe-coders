import type { Page } from "@playwright/test";
import { installIpUsage } from "./ip-usage-browser";

export async function installTeamPagination(page: Page) {
  const gateway = await installIpUsage(page);
  const user = gateway.bootstrap.user;
  if (!user?.scopes) throw new Error("Team pagination fixture requires an authenticated user");
  user.role = "admin";
  user.roles = ["admin"];
  user.scopes.push("admin:write");
  gateway.bootstrap.roles = ["admin"];
  for (const feature of gateway.bootstrap.migration_registry ?? []) {
    if (feature.feature_id === "access.users") {
      feature.status = "preview";
      feature.read_only = false;
    }
  }
  const rows = Array.from({ length: 61 }, (_, index) => ({
    id: `team_page_${String(index).padStart(3, "0")}`,
    name: index === 0 ? "=1+1" : `운영팀 ${String(index).padStart(2, "0")}`,
    created_at: "2026-11-12T00:00:00Z",
    updated_at: "2026-11-12T00:00:00Z",
  }));
  const reads: URLSearchParams[] = [];
  const state = { registeredStatus: 200, usageStatus: 200 };
  await page.route("**/admin/teams/scorecard?*", (route) => route.fulfill({ json: { teams: [] } }));
  await page.route("**/admin/benchmark/teams?*", (route) => route.fulfill({ json: { teams: [] } }));
  await page.route(/\/admin\/teams(?:\?.*)?$/u, (route) => {
    const query = new URL(route.request().url()).searchParams;
    const registered = query.get("view") === "registered";
    const status = registered ? state.registeredStatus : state.usageStatus;
    if (status !== 200)
      return route.fulfill({
        status,
        json: { error: { code: "fixture_failure", message: "private fixture" } },
        headers: { "X-Request-ID": "req_team_page" },
      });
    if (!registered)
      return route.fulfill({
        json: query.get("view") === "usage" ? { teams: [] } : { teams: [], auth_teams: rows },
      });
    reads.push(query);
    const offset = Number(query.get("offset") ?? 0),
      limit = Number(query.get("limit") ?? 25);
    const search = (query.get("q") ?? "").toLowerCase();
    const sorts = (query.get("sort") || "name:asc").split(",");
    const filtered = rows.filter(
      (row) => row.name.toLowerCase().includes(search) || row.id.toLowerCase().includes(search),
    );
    filtered.sort((a, b) => {
      for (const part of [...sorts, "id:asc"]) {
        const [field, direction] = part.split(":");
        const left = a[field as keyof typeof a],
          right = b[field as keyof typeof b];
        if (left !== right) return (left < right ? -1 : 1) * (direction === "desc" ? -1 : 1);
      }
      return 0;
    });
    return route.fulfill({
      json: { auth_teams: filtered.slice(offset, offset + limit), total: filtered.length, offset, limit },
    });
  });
  return { ...gateway, rows, reads, state };
}
