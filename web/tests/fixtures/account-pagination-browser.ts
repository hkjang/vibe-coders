import type { Page } from "@playwright/test";
import { installIpUsage } from "./ip-usage-browser";

export async function installAccountPagination(page: Page) {
  const gateway = await installIpUsage(page);
  const rows = Array.from({ length: 61 }, (_, index) => ({
    id: `usr_page_${String(index).padStart(3, "0")}`,
    email: `account-${index}@example.test`,
    name: index === 0 ? "=1+1" : `운영 계정 ${index}`,
    role: "developer",
    status: index % 2 ? "suspended" : "active",
    team_id: index === 0 ? "" : "team_public",
    team_name: index === 0 ? "" : "공개 검증팀",
    created_at: "2026-11-12T00:00:00Z",
  }));
  const reads: URLSearchParams[] = [];
  const state = { accountStatus: 200, usageStatus: 200 };
  await page.route("**/admin/benchmark/users?*", (route) => route.fulfill({ json: { users: [] } }));
  await page.route(/\/admin\/users(?:\?.*)?$/u, (route) => {
    const query = new URL(route.request().url()).searchParams;
    const isAccount = query.get("view") === "accounts";
    const status = isAccount ? state.accountStatus : state.usageStatus;
    if (status !== 200)
      return route.fulfill({
        status,
        json: { error: { code: "fixture_failure", message: "private fixture" } },
        headers: { "X-Request-ID": "req_account_page" },
      });
    if (!isAccount) return route.fulfill({ json: { users: [], team_names: {} } });
    reads.push(query);
    const offset = Number(query.get("offset") ?? 0),
      limit = Number(query.get("limit") ?? 25);
    let filtered = rows.filter(
      (row) =>
        (!query.get("q") || row.email.includes(query.get("q") ?? "")) &&
        (!query.get("status") || row.status === query.get("status")) &&
        (!query.has("team_id") || row.team_id === query.get("team_id")),
    );
    if (query.get("sort") === "email:desc") filtered = [...filtered].reverse();
    return route.fulfill({
      json: { accounts: filtered.slice(offset, offset + limit), total: filtered.length, offset, limit },
    });
  });
  return { ...gateway, rows, reads, state };
}
