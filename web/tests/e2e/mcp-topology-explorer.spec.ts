import { expect, test, type Page } from "@playwright/test";
import type { McpTopologyResponse, UiBootstrapResponse } from "../../src/shared/api/generated";

async function install(page: Page) {
  const user = {
    id: "topology-reader",
    email: "reader@example.invalid",
    name: "연결 조회",
    role: "admin",
    roles: ["admin"],
    team_id: "",
    scopes: ["observability:read"],
  };
  const bootstrap: UiBootstrapResponse = {
    backend_version: "v0.86.61",
    ui_version: "topology-fixture",
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
      credential_prefixes: ["custom_"],
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
  const topology: McpTopologyResponse = {
    nodes: [
      { id: "gateway", label: "공개 게이트웨이", kind: "gateway" },
      { id: "upstream:public", label: "공개 서버", kind: "upstream", status: "enabled" },
      { id: "tool:read", label: "공개 읽기 도구", kind: "tool", decision: "block" },
    ],
    edges: [
      { from: "gateway", to: "upstream:public", label: "aggregates" },
      { from: "upstream:public", to: "tool:read", label: "tools/call" },
    ],
  };
  const state = { status: 200, malformed: false };
  const calls: string[] = [],
    unexpected: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/app/")) return route.continue();
    const json = (body: unknown) => route.fulfill({ json: body });
    if (url.pathname === "/auth/me") return json({ authenticated: true, user });
    if (url.pathname === "/admin/ui-bootstrap") return json(bootstrap);
    if (url.pathname === "/health") return json({ status: "ok" });
    calls.push(route.request().method() + " " + url.pathname);
    if (url.pathname === "/admin/mcp/topology" && route.request().method() === "GET") {
      if (state.status !== 200)
        return route.fulfill({
          status: state.status,
          headers: { "X-Request-ID": "topology-public-error" },
          json: { error: { code: "mcp_topology_unavailable", type: "server_error", message: "unavailable" } },
        });
      return json(state.malformed ? { nodes: topology.nodes } : topology);
    }
    unexpected.push(url.pathname);
    return route.fulfill({ status: 500, json: {} });
  });
  return { topology, state, calls, unexpected };
}
const dialog = (page: Page) => page.getByRole("dialog", { name: "MCP 연결 상세", exact: true });

test("삭제된 선택 주소를 유효한 노드로 바꾼 뒤 실제 버튼에 초점을 복원한다", async ({ page }) => {
  await install(page);
  await page.goto("/app/mcp?tab=topology&node=deleted");
  await expect(page.getByText("선택한 노드가 현재 목록에 없습니다.", { exact: true })).toBeVisible();
  const trigger = page.getByRole("button", { name: "공개 서버 연결 상세", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("연결도·상세·직접 주소 새로고침과 초점 복귀", async ({ page }) => {
  const fixture = await install(page);
  await page.goto("/app/mcp?tab=topology");
  const trigger = page.getByRole("button", { name: "공개 서버 연결 상세", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(dialog(page).getByText("게이트웨이 통합", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.reload();
  await expect(dialog(page).getByText("tools/call", { exact: true })).toBeVisible();
  await dialog(page).getByRole("button", { name: "공개 읽기 도구", exact: true }).click();
  await expect(dialog(page).getByText("차단", { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("node")).toBe("tool:read");
  expect(fixture.calls.every((call) => call === "GET /admin/mcp/topology")).toBe(true);
  expect(fixture.unexpected).toEqual([]);
});
test("필터·페이지는 주소와 새로고침에 유지되고 전체 수신 목록을 탐색한다", async ({ page }) => {
  const fixture = await install(page);
  fixture.topology.nodes.push(
    ...Array.from({ length: 80 }, (_, i) => ({
      id: `tool:${i}`,
      label: `공개 도구 ${i}`,
      kind: "tool",
      decision: "allow",
    })),
  );
  await page.goto("/app/mcp?tab=topology&kind=tool&decision=allow&topology_page=2");
  const table = page.getByRole("table", { name: "MCP 연결 노드", exact: true });
  await expect(table).toContainText("공개 도구 25");
  await expect(table).not.toContainText("공개 도구 50");
  await page.reload();
  await expect(table).toContainText("공개 도구 25");
  await page.getByLabel("이름·노드 ID 검색", { exact: true }).fill("공개 도구 79");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(table).toContainText("공개 도구 79");
  await expect(table.getByRole("row")).toHaveCount(2);
  await page.getByRole("button", { name: "필터 초기화", exact: true }).click();
  await expect(table).toContainText("공개 서버");
});
test("초기 실패·불완전 응답은 빈 구조가 아니며 재조회로 복구한다", async ({ page }) => {
  const fixture = await install(page);
  fixture.state.status = 503;
  await page.goto("/app/mcp?tab=topology");
  await expect(page.getByText("MCP 연결 구조 조회에 실패했습니다.", { exact: true })).toBeVisible();
  await expect(page.getByText("요청 ID: topology-public-error", { exact: true })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  fixture.state.status = 200;
  fixture.state.malformed = true;
  await page.getByRole("button", { name: "MCP 연결 구조 다시 시도", exact: true }).click();
  await expect(page.getByRole("table")).toHaveCount(0);
  fixture.state.malformed = false;
  await page.getByRole("button", { name: "MCP 연결 구조 다시 시도", exact: true }).click();
  await expect(page.getByRole("table")).toContainText("공개 서버");
});
test("403은 이전 구조를 숨기고 수동 재확인으로 복구한다", async ({ page }) => {
  const fixture = await install(page);
  await page.goto("/app/mcp?tab=topology");
  await expect(page.getByRole("table")).toBeVisible();
  fixture.state.status = 403;
  await page.getByRole("button", { name: "연결 구조 새로고침", exact: true }).click();
  await expect(page.getByText("연결 구조 조회 권한을 다시 확인하세요.", { exact: true })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  fixture.state.status = 200;
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.getByRole("table")).toBeVisible();
});
test("누락 연결을 알리고 자격정보 검색을 주소에 넣지 않는다", async ({ page }) => {
  const fixture = await install(page);
  fixture.topology.edges.push({ from: "upstream:public", to: "missing", label: "tools/call" });
  await page.goto("/app/mcp?tab=topology");
  await expect(page.getByText("일부 연결 대상을 확인할 수 없습니다.", { exact: true })).toBeVisible();
  await page.getByLabel("이름·노드 ID 검색", { exact: true }).fill("custom_" + "x".repeat(48));
  await page.getByRole("button", { name: "검색", exact: true }).click();
  expect(page.url()).not.toContain("custom_");
  await expect(
    page.getByText("인증정보로 보이는 검색어는 주소에 저장하지 않습니다. 비밀정보를 제거한 뒤 검색하세요.", {
      exact: true,
    }),
  ).toBeVisible();
});
test("모바일 어두운 연결 구조는 내부 스크롤·키보드·접근성을 유지한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await install(page);
  await page.goto("/app/mcp?tab=topology");
  await expect(page.getByRole("table")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await page.locator(".mcp-topology-node").evaluateAll((nodes) =>
      nodes.every((node) => {
        const outer = node.getBoundingClientRect();
        return Array.from(node.children).every((child) => {
          const box = child.getBoundingClientRect();
          return (
            box.top >= outer.top && box.bottom <= outer.bottom && child.scrollHeight <= child.clientHeight
          );
        });
      }),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(async () =>
      (
        await (
          window as unknown as { axe: { run(root: Document): Promise<{ violations: { id: string }[] }> } }
        ).axe.run(document)
      ).violations.map((v) => v.id),
    ),
  ).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("mcp-topology-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "공개 서버 목록 상세", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  expect(
    await page.evaluate(async () =>
      (
        await (
          window as unknown as { axe: { run(root: Document): Promise<{ violations: { id: string }[] }> } }
        ).axe.run(document)
      ).violations.map((v) => v.id),
    ),
  ).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("mcp-topology-detail-mobile.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "공개 서버 목록 상세", exact: true })).toBeFocused();
});
