import { expect, test, type Page } from "@playwright/test";
import { installRequestBulk } from "../fixtures/request-bulk-browser";
import { installSettingsWorkspace } from "../fixtures/settings-workspace-browser";
import { visibleState } from "../fixtures/table-state-visibility";

async function checkTable(page: Page, caption: string) {
  const table = page.getByRole("table", { name: caption, exact: true });
  const shell = table.locator("..").locator("..");
  await expect(table.locator(".data-table-state")).toBeVisible();
  for (const width of [390, 560, 1024]) {
    await page.setViewportSize({ width, height: 960 });
    await table.scrollIntoViewIfNeeded();
    for (const fraction of [0, 0.5, 1]) await visibleState(shell, fraction);
  }
}

test("요청 목록의 빈 상태 안내는 열 설정과 화면 크기가 바뀌어도 보인다", async ({ page }) => {
  const api = await installRequestBulk(page);
  api.bulk.empty = true;
  await page.setViewportSize({ width: 390, height: 960 });
  await page.goto("observability/requests");
  await checkTable(page, "현재 페이지 요청 목록");
  expect(api.writes).toEqual([]);
});

const cases = [
  {
    tab: "audit",
    paths: ["/admin/audit-logs", "/admin/audit/auth-events"],
    tables: ["관리자 변경 이력", "최근 인증 이벤트"],
  },
  { tab: "errors", paths: ["/admin/system-errors"], tables: ["시스템 오류 로그"] },
  { tab: "tracking", paths: ["/admin/tracking/violations"], tables: ["차단된 출처"] },
  { tab: "changesets", paths: ["/admin/change-sets"], tables: ["변경 세트 목록"] },
  { tab: "console", paths: ["/admin/settings/effective"], tables: ["기능별 콘솔 전환 상태"] },
] as const;

async function installSettings(page: Page, delayed: readonly string[] = []) {
  const api = await installSettingsWorkspace(page);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const responses: Record<string, unknown> = {
    "/admin/audit-logs": { audit_logs: [] },
    "/admin/audit/auth-events": { events: [] },
    "/admin/system-errors": { errors: [] },
    "/admin/tracking/violations": { enabled: false, active: false, provider: "none", violations: [] },
    "/admin/change-sets": { change_sets: [] },
    "/admin/ui-telemetry/summary": {
      enabled: false,
      days: 7,
      from: "2026-11-10T00:00:00Z",
      to: "2026-11-17T00:00:00Z",
      retention_days: 30,
      visit_limit: 100000,
      features: [],
    },
    "/admin/settings/effective": { settings: [] },
    "/admin/sso/keycloak/config": {
      enabled: false,
      allow_local_login: true,
      role_map: {},
      role_map_default: {},
      role_map_custom: true,
      version: 1,
    },
    "/admin/roles": { roles: [{ role: "viewer" }, { role: "admin" }] },
    "/admin/mcp/oauth": { enabled: false, active: false },
  };
  await page.route("**/admin/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (!(path in responses)) return route.fallback();
    expect(request.method()).toBe("GET");
    if (delayed.includes(path)) await gate;
    return route.fulfill({ json: responses[path] });
  });
  return { ...api, release, responses };
}

for (const item of cases)
  test(`설정 ${item.tab}: 직접 작성한 표의 로딩 안내도 보이고 응답 후 바뀐다`, async ({ page }) => {
    const api = await installSettings(page, item.paths);
    await page.setViewportSize({ width: 390, height: 960 });
    await page.goto(`system/settings?tab=${item.tab}`);
    try {
      for (const caption of item.tables) await checkTable(page, caption);
    } finally {
      api.release();
    }
    if (item.tab === "console")
      await expect(page.getByText("전환 설정을 제공하는 기능이 없습니다.", { exact: true })).toBeVisible();
    else await expect(page.locator(".data-table-state")).toHaveCount(0);
    expect(api.writes).toEqual([]);
    expect(api.unexpected).toEqual([]);
  });

test("SSO 역할 매핑이 없으면 긴 한글 안내를 표 영역 안에서 읽을 수 있다", async ({ page }) => {
  const api = await installSettings(page);
  await page.setViewportSize({ width: 390, height: 960 });
  await page.goto("system/settings?tab=sso");
  await checkTable(page, "Keycloak 역할 매핑");
  expect(api.writes).toEqual([]);
  expect(api.unexpected).toEqual([]);
});

for (const tab of ["audit", "errors", "tracking"] as const)
  test(`설정 ${tab}: 긴 기록이 있어도 표만 가로 스크롤하고 키보드로 탐색한다`, async ({ page }) => {
    const api = await installSettings(page);
    api.responses["/admin/audit-logs"] = {
      audit_logs: [
        {
          id: "public-audit",
          action: "공개 설정 변경",
          before_value: "공개 이전 값 ".repeat(20),
          after_value: "공개 이후 값 ".repeat(20),
        },
      ],
    };
    api.responses["/admin/audit/auth-events"] = {
      events: [
        {
          id: "public-auth",
          event_type: "공개 인증",
          actor_user_id: "public-user",
          detail: "공개 인증 기록 ".repeat(20),
        },
      ],
    };
    api.responses["/admin/system-errors"] = {
      errors: [{ id: "public-error", component: "gateway", error_message: "공개 오류 기록 ".repeat(20) }],
    };
    api.responses["/admin/tracking/violations"] = {
      enabled: false,
      active: false,
      provider: "none",
      violations: [
        {
          origin: "https://public-origin.example.invalid",
          directive: "script-src",
          count: 1,
          allowed: false,
        },
      ],
    };
    await page.setViewportSize({ width: 390, height: 960 });
    await page.goto(`system/settings?tab=${tab}`);
    const tables = cases.find((item) => item.tab === tab)?.tables ?? [];
    expect(tables.length).toBeGreaterThan(0);
    for (const caption of tables) {
      const table = page.getByRole("table", { name: caption, exact: true });
      await expect(table.locator("tbody tr")).toHaveCount(1);
      await expect(table.locator(".data-table-state")).toHaveCount(0);
      const viewport = table.locator("..");
      await expect(viewport).toHaveAttribute("role", "region");
      await viewport.focus();
      await expect(viewport).toBeFocused();
      await viewport.press("ArrowRight");
      await expect.poll(() => viewport.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(
      true,
    );
    expect(api.writes).toEqual([]);
    expect(api.unexpected).toEqual([]);
  });
