import { expect, test, type Page } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

async function install(page: Page) {
  const user = {
    id: "public-reader",
    email: "reader@example.invalid",
    name: "요청 조회 검증",
    role: "admin",
    roles: ["admin"],
    team_id: "",
    scopes: ["observability:read"],
  };
  const bootstrap: UiBootstrapResponse = {
    backend_version: "v0.86.61",
    ui_version: "mcp-request-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/mcp",
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
    user,
    roles: user.roles,
    permissions: user.scopes,
    capabilities: { raw_prompt_view: false },
    allowed_features: ["mcp.overview"],
    migration_registry: [
      {
        feature_id: "mcp.overview",
        title: "MCP 운영",
        app_path: "/app/mcp",
        legacy_path: "/admin#/mcp",
        status: "preview_read_only",
        risk_level: "medium",
        required_permission: "observability:read",
        read_only: true,
        enabled_roles: ["admin"],
        rollout_percent: 100,
        fallback_enabled: true,
        minimum_api_version: "v0.84.0",
        available: true,
      },
    ],
    system_status: { status: "healthy" },
    legacy_route_map: {},
  };
  const state = { listError: 0, flowError: 0, agentError: 0, long: false, stepStatus: "block" };
  const calls: string[] = [];
  const unexpected: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/app/")) return route.continue();
    const json = (body: unknown) => route.fulfill({ json: body });
    const error = (status: number) =>
      route.fulfill({
        status,
        headers: { "X-Request-ID": "public-read-error" },
        json: { error: { message: "public fixture unavailable", type: "server_error", code: "unavailable" } },
      });
    if (url.pathname === "/auth/me") return json({ authenticated: true, user });
    if (url.pathname === "/admin/ui-bootstrap") return json(bootstrap);
    if (url.pathname === "/health") return json({ status: "ok" });
    calls.push(route.request().method() + " " + url.pathname + url.search);
    if (route.request().method() === "GET") {
      if (url.pathname === "/admin/mcp/requests") {
        if (state.listError) return error(state.listError);
        return json({
          requests: [
            {
              id: "public-request",
              model: "public-model",
              status_code: 200,
              latency_ms: 0,
              tool_count: 1,
              created_at: "2026-10-14T00:00:00Z",
              api_key_id: "public-key",
            },
          ],
        });
      }
      if (url.pathname === "/admin/mcp/requests/public-request/waterfall") {
        if (state.flowError) return error(state.flowError);
        return json({
          request_id: "public-request",
          trace_id: "public-trace",
          api_key_id: "public-key",
          status: 200,
          latency_ms: 0,
          steps: [
            {
              name: "policy_evaluation",
              status: state.stepStatus,
              detail: state.long ? "긴공개정책설명".repeat(100) : "현재 정책",
            },
          ],
          tools: [
            {
              server_label: "public-server",
              tool_name: "public-tool",
              is_mcp: true,
              is_error: false,
              created_at: "2026-10-14T00:00:00Z",
            },
          ],
        });
      }
      if (url.pathname === "/admin/mcp/agentic-runs") {
        if (state.agentError) return error(state.agentError);
        return json({ request_id: "public-request", agentic: true, note: "공개 실행 기록" });
      }
    }
    unexpected.push(route.request().method() + " " + url.pathname);
    return error(500);
  });
  return { state, calls, unexpected };
}
const dialogFor = (page: Page) => page.getByRole("dialog", { name: "MCP 요청 처리 흐름", exact: true });
async function open(page: Page) {
  await page.goto("/app/mcp?tab=requests");
  await page.getByRole("button", { name: "public-request 처리 흐름 열기", exact: true }).click();
  return dialogFor(page);
}

for (const [status, label] of [
  ["approval_required", "승인 필요"],
  ["not_in_allowlist", "허용목록 외"],
] as const) {
  test(`서버 상태 ${status}의 한글 표시`, async ({ page }) => {
    const fixture = await install(page);
    fixture.state.stepStatus = status;
    const dialog = await open(page);
    await expect(dialog.getByText(label, { exact: true })).toBeVisible();
    await expect(dialog.getByText(status, { exact: true })).toHaveCount(0);
  });
}

test("조회 권한만으로 상세를 열고 주소 새로고침·키보드 복귀를 지원한다", async ({ page }) => {
  const fixture = await install(page);
  const dialog = await open(page);
  await expect(dialog.getByText("현재 서버 정책", { exact: true })).toBeVisible();
  await expect(dialog.getByText("호출 당시의 정책 기록과 구분하세요.", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/request_id=public-request/);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "public-request 처리 흐름 열기", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await page.reload();
  await expect(dialog.getByText("public-trace", { exact: true })).toBeVisible();
  expect(fixture.calls.every((call) => call.startsWith("GET "))).toBe(true);
  expect(fixture.unexpected).toEqual([]);
});
test("목록 실패는 빈 기록이 아니며 수동으로 다시 조회한다", async ({ page }) => {
  const fixture = await install(page);
  fixture.state.listError = 500;
  await page.goto("/app/mcp?tab=requests");
  await expect(page.getByText("MCP 요청 로그 조회에 실패했습니다.", { exact: true })).toBeVisible();
  await expect(page.getByText("MCP 호출 기록이 없습니다.", { exact: true })).toHaveCount(0);
  fixture.state.listError = 0;
  await page.getByRole("button", { name: "MCP 요청 로그 다시 시도", exact: true }).click();
  await expect(page.getByText("public-model", { exact: true })).toBeVisible();
});
test("독립 상세 오류의 재시도는 정상 처리 흐름을 다시 요청하지 않는다", async ({ page }) => {
  const fixture = await install(page);
  fixture.state.agentError = 500;
  const dialog = await open(page);
  await expect(dialog.getByText("에이전트 실행 기록 조회에 실패했습니다.", { exact: true })).toBeVisible();
  await expect(dialog.getByText("확인 불가", { exact: true })).toBeVisible();
  await expect(dialog.getByText("public-trace", { exact: true })).toBeVisible();
  fixture.state.agentError = 0;
  await dialog.getByRole("button", { name: "에이전트 실행 기록 다시 시도", exact: true }).click();
  await expect(dialog.getByText("기록 있음", { exact: true })).toBeVisible();
  expect(fixture.calls.filter((call) => call.includes("/waterfall"))).toHaveLength(1);
});
test("상세 403 뒤 이전 목록과 상세를 숨기고 확인 후 복구한다", async ({ page }) => {
  const fixture = await install(page);
  fixture.state.flowError = 403;
  await open(page);
  await expect(page.getByText("MCP 요청 조회 권한을 다시 확인하세요.", { exact: true })).toBeVisible();
  await expect(dialogFor(page)).toHaveCount(0);
  await expect(page.getByText("public-model", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.getByText("public-model", { exact: true })).toBeVisible();
  await expect(dialogFor(page)).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("request_id")).toBe(false);
  expect(fixture.calls.filter((call) => call.includes("/waterfall"))).toHaveLength(1);
});
test("오류 필터 초기화가 화면·주소·요청에 일치한다", async ({ page }) => {
  const fixture = await install(page);
  await page.goto("/app/mcp?tab=requests&errors=1");
  await expect(page.getByRole("checkbox", { name: "오류만 보기", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "초기화", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "오류만 보기", exact: true })).not.toBeChecked();
  expect(new URL(page.url()).searchParams.has("errors")).toBe(false);
  await expect
    .poll(() => fixture.calls.filter((call) => call.startsWith("GET /admin/mcp/requests?")).length)
    .toBe(2);
  expect(fixture.calls.at(-1)).not.toContain("errors=1");
  await page.getByLabel("서버 라벨", { exact: true }).fill("draft-server");
  await page.getByLabel("도구 이름", { exact: true }).fill("draft-tool");
  await page.getByRole("checkbox", { name: "오류만 보기", exact: true }).check();
  await page.getByRole("button", { name: "초기화", exact: true }).click();
  await expect(page.getByLabel("서버 라벨", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("도구 이름", { exact: true })).toHaveValue("");
  await expect(page.getByRole("checkbox", { name: "오류만 보기", exact: true })).not.toBeChecked();
});
test("390px 어두운 상세창의 긴 데이터·키보드·접근성을 검증한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  const fixture = await install(page);
  fixture.state.long = true;
  const dialog = await open(page);
  await expect(dialog.getByRole("table", { name: "요청의 도구 호출", exact: true })).toContainText(
    "public-tool",
  );
  const close = dialog.getByRole("button", { name: "패널 닫기", exact: true });
  await close.focus();
  await expect(close).toBeFocused();
  await expect(close).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await dialog.evaluate((node) => {
      const r = node.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth;
    }),
  ).toBe(true);
  expect(
    await page.evaluate(async () =>
      (
        await (
          window as unknown as {
            axe: { run(root: Document): Promise<{ violations: { id: string }[] }> };
          }
        ).axe.run(document)
      ).violations.map((v) => v.id),
    ),
  ).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("mcp-request-mobile.png"), fullPage: true });
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});
