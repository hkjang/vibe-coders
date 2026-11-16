import type { Page } from "@playwright/test";
import { installOverviewWorkspace } from "./overview-workspace-browser";
import {
  opsHome,
  incidents,
  workers,
  preflight,
  indexHealth,
  migrationSql,
} from "../../src/features/system/health/system-health-fixtures";

export async function installSystemHealthWorkspace(page: Page) {
  const fixture = await installOverviewWorkspace(page);
  fixture.bootstrap.backend_version = "v0.86.106";
  const state = { denyHome: false, failIndex: false, reads: {} as Record<string, number> };
  const bodies: Record<string, unknown> = {
    "/admin/ops/home": opsHome,
    "/admin/incidents/candidates": incidents,
    "/admin/ops/workers": {
      ...workers,
      workers: [
        {
          name: "async_logger",
          status: "ok",
          running: true,
          queue_depth: 2,
          capacity: 100,
          dropped: 0,
          detail: "요청 로그 120건 기록",
        },
      ],
    },
    "/admin/ops/preflight": { ...preflight, version: "v0.86.106", note: "실패 항목을 해결한 뒤 배포하세요." },
    "/admin/index-health": indexHealth,
    "/admin/migration-sql": {
      ...migrationSql,
      counts: { total: 121, create_table: 121, create_index: 0 },
      statements: Array.from({ length: 121 }, (_, i) => ({
        seq: i + 1,
        kind: "create_table",
        table: `table_${i + 1}`,
        sql: `CREATE TABLE table_${i + 1} (id TEXT);`,
      })),
    },
  };
  await page.route("**/admin/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (!(path in bodies)) return route.fallback();
    if (request.method() !== "GET") {
      fixture.writes.push(request);
      return route.fulfill({ status: 405, json: { error: { message: "unexpected write" } } });
    }
    state.reads[path] = (state.reads[path] ?? 0) + 1;
    if (path === "/admin/ops/home" && state.denyHome)
      return route.fulfill({ status: 403, json: { error: { message: "denied" } } });
    if (path === "/admin/index-health" && state.failIndex)
      return route.fulfill({
        status: 503,
        json: { error: { message: "unavailable" } },
        headers: { "X-Request-ID": "index-workspace-fixture" },
      });
    return route.fulfill({ json: bodies[path] });
  });
  return { ...fixture, state, overviewState: fixture.state };
}
