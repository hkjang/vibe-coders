import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// Embedded Go assets and CSP; management APIs use public synthetic fixtures.
async function install(page: Page) {
  const state = {
    preview: "마스킹된 질문 미리보기",
    fail: 0,
    denied: false,
    reads: [] as URL[],
    unexpected: [] as string[],
  };
  const features = ["observability.sessions", "agents.workflows", "agents.apps"];
  const bootstrap: UiBootstrapResponse = {
    backend_version: "v0.86.153",
    ui_version: "fixture-session-page",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/observability/sessions",
      legacy_fallback: true,
      feedback_enabled: false,
      telemetry_enabled: false,
    },
    authentication: {
      enabled: false,
      authenticated: true,
      mode: "open",
      keycloak_enabled: false,
      allow_local_login: true,
      sso_login_url: "/auth/keycloak/login",
    },
    user: {
      id: "public-owner",
      email: "public@example.invalid",
      name: "운영 담당자",
      team_id: "public-team",
      roles: ["admin"],
      role: "admin",
      scopes: ["admin:read"],
    },
    roles: ["admin"],
    permissions: ["admin:read"],
    allowed_features: features,
    capabilities: { raw_prompt_view: false },
    system_status: { status: "healthy" },
    legacy_route_map: {},
    migration_registry: (
      [
        ["observability.sessions", "세션 비행기록", "/app/observability/sessions", "/admin#/sessions"],
        ["agents.workflows", "워크플로", "/app/agents/workflows", "/admin#/workflows"],
        ["agents.apps", "AI 업무 앱", "/app/agents/apps", "/admin#/apps"],
      ] as const
    ).map(([feature_id, title, app_path, legacy_path]) => ({
      feature_id: feature_id,
      title: title,
      app_path: app_path,
      legacy_path: legacy_path,
      status: "preview_read_only",
      risk_level: "low",
      required_permission: "admin:read",
      read_only: true,
      enabled_roles: ["admin"],
      rollout_percent: 100,
      fallback_enabled: true,
      minimum_api_version: "v0.83.0",
      available: true,
    })),
  };
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname === "/admin/ui-bootstrap") return route.fulfill({ json: bootstrap });
    if (["/health", "/ready"].includes(url.pathname)) return route.fulfill({ json: { status: "ok" } });
    if (url.pathname === "/admin/sessions/page" && request.method() === "GET") {
      state.reads.push(url);
      const fail = state.fail;
      state.fail = 0;
      if (fail || state.denied)
        return route.fulfill({
          status: fail || 403,
          headers: { "X-Request-ID": "public-session-page-error" },
          json: { error: { message: "PRIVATE_SOURCE_FAILURE" } },
        });
      const days = Number(url.searchParams.get("days")),
        limit = Number(url.searchParams.get("limit")),
        offset = Number(url.searchParams.get("offset"));
      const total = url.searchParams.get("q") ? 1 : 31;
      const sessions = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) => ({
        row_key: `session_${String(offset + index).padStart(43, "0")}`,
        session_id: `session-${offset + index + 1}`,
        requests: 2,
        errors: 1,
        models: 1,
        api_keys: 1,
        total_tokens: 100,
        cost_krw: 5,
        first_seen: "2026-11-17T00:00:00Z",
        last_seen: "2026-11-17T01:00:00Z",
        last_message: state.preview,
      }));
      return route.fulfill({
        headers: { "Cache-Control": "no-store" },
        json: {
          session_page_version: 1,
          days,
          limit,
          offset,
          from: "2026-11-11T00:01:00Z",
          to: "2026-11-18T00:01:00Z",
          sessions,
          summary: {
            sessions: total,
            requests: total * 2,
            errors: total,
            total_tokens: total * 100,
            cost_krw: total * 5,
          },
        },
      });
    }
    if (url.pathname === "/admin/sessions/session-26/flight-recorder" && request.method() === "GET")
      return route.fulfill({ json: { session_id: "session-26", events: [] } });
    if (url.pathname.startsWith("/admin/") || url.pathname.startsWith("/auth/")) {
      state.unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: { message: "unexpected fixture route" } } });
    }
    return route.continue();
  });
  return state;
}
test("세션 검색·페이지·새로고침·키보드 초점은 서버 조건과 함께 유지된다", async ({ page }) => {
  const api = await install(page);
  await page.goto("observability/sessions?offset=25");
  await expect(page.getByText("session-26", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "검색 범위 전체 세션 요약" })).toContainText("31");
  const detail = page.getByRole("button", { name: "session-26 세션 비행기록 열기", exact: true });
  await detail.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(detail).toBeFocused();
  await page.reload();
  await expect(page.getByText("session-26", { exact: true })).toBeVisible();
  const previous = page.getByRole("button", { name: "이전 세션" });
  await previous.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("session-1", { exact: true })).toBeVisible();
  await expect(previous).toBeFocused();
  await expect(previous).toHaveAttribute("aria-disabled", "true");
  const reads = api.reads.length;
  await page.keyboard.press("Enter");
  expect(api.reads.length).toBe(reads);
  await page.getByLabel("페이지당 세션 수").selectOption("50");
  await expect(page).toHaveURL(/page_size=50/);
  await page.getByLabel("세션 ID 검색").fill("session-1");
  await page.getByRole("button", { name: "조회", exact: true }).click();
  await expect(page).toHaveURL(/q=session-1/);
  await expect.poll(() => api.reads.at(-1)?.searchParams.get("q")).toBe("session-1");
  expect(api.unexpected).toEqual([]);
});
test("세션 조회 오류·권한 거부·재시도를 구분하고 원문 API로 대체하지 않는다", async ({ page }) => {
  const api = await install(page);
  await page.goto("observability/sessions?offset=25");
  await expect(page.getByText("session-26", { exact: true })).toBeVisible();
  api.fail = 500;
  await page.getByRole("button", { name: "새로고침" }).click();
  await expect(page.getByText("세션 목록을 불러오지 못했습니다.", { exact: true })).toBeVisible();
  await expect(page.getByText("session-26", { exact: true })).toHaveCount(0);
  await expect(page.getByText("PRIVATE_SOURCE_FAILURE")).toHaveCount(0);
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByText("session-26", { exact: true })).toBeVisible();
  api.denied = true;
  await page.getByRole("button", { name: "새로고침" }).click();
  await expect(page.getByText("세션 목록 조회가 거부되었습니다.")).toBeVisible();
  api.denied = false;
  await page.getByRole("button", { name: "권한 확인 후 다시 조회" }).click();
  await expect(page.getByText("session-26", { exact: true })).toBeVisible();
  expect(api.unexpected).toEqual([]);
});
for (const empty of [false, true])
  for (const theme of ["light", "dark"] as const)
    for (const width of [1440, 390])
      test(`세션 전체 조회 ${empty ? "empty" : "rows"} ${theme} ${width}`, async ({ page }) => {
        const api = await install(page);
        await page.setViewportSize({ width, height: 1900 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.clock.setFixedTime(new Date("2026-11-18T00:01:00Z"));
        await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
        await page.goto(`observability/sessions?offset=${empty ? 50 : 25}`);
        await expect(page.getByRole("region", { name: "검색 범위 전체 세션 요약" })).toBeVisible();
        if (empty) await expect(page.getByText(/현재 페이지에 세션이 없습니다/)).toBeVisible();
        else await expect(page.getByText("session-26", { exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        const audit = await page.evaluate(async () =>
          (window as typeof window & { axe: { run: () => Promise<AxeResults> } }).axe.run(),
        );
        expect(audit.violations).toEqual([]);
        const heading = page.getByRole("heading", { name: "세션 비행기록", exact: true });
        expect((await heading.boundingBox())?.y).toBeGreaterThanOrEqual(56);
        await expect(page.getByRole("main")).toHaveScreenshot(
          `sessions-${empty ? "empty" : "rows"}-${theme}-${width}.png`,
        );
        expect((await heading.boundingBox())?.y).toBeGreaterThanOrEqual(56);
        expect(api.unexpected).toEqual([]);
      });

test("160코드포인트의 한글·이모지 미리보기도 목록과 전체 합계를 표시한다", async ({ page }) => {
  const state = await install(page);
  state.preview = "가".repeat(80) + "🙂".repeat(79) + "…";
  await page.goto("observability/sessions");
  await expect(page.getByText(state.preview, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "다음 세션" })).toBeEnabled();
  expect(state.reads).toHaveLength(1);
  expect(state.unexpected).toEqual([]);
});

test("URL 필터 없는 세션 초안·검증 오류는 초기화 버튼으로 제거된다", async ({ page }) => {
  const api = await install(page);
  await page.goto("observability/sessions");
  await expect(page.getByText("session-1", { exact: true })).toBeVisible();
  const reads = api.reads.length;
  await page.getByLabel("조회 기간(일)").fill("30");
  await page.getByLabel("세션 ID 검색").fill("x".repeat(257));
  await page.getByRole("button", { name: "조회", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("256바이트");
  const reset = page.getByRole("button", { name: "초기화", exact: true });
  await reset.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("세션 ID 검색")).toHaveValue("");
  await expect(page.getByLabel("조회 기간(일)")).toHaveValue("7");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(reset).toBeFocused();
  expect(new URL(page.url()).search).toBe("");
  expect(api.reads.length).toBe(reads);
  expect(api.unexpected).toEqual([]);
});
