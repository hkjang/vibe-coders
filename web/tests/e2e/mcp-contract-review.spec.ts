import { expect, test, type Page } from "@playwright/test";
import type axe from "axe-core";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

async function install(page: Page) {
  const user = {
    id: "contract-public-admin",
    email: "public@example.invalid",
    name: "공개 관리자",
    role: "admin",
    roles: ["admin"],
    team_id: "",
    scopes: ["admin:read", "observability:read", "mcp:admin"],
  };
  const bootstrap: UiBootstrapResponse = {
    backend_version: "v0.86.61",
    ui_version: "contract-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/mcp-gateway",
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
    allowed_features: ["mcp.gateway"],
    migration_registry: [
      {
        feature_id: "mcp.gateway",
        title: "게이트웨이 MCP",
        app_path: "/app/mcp-gateway",
        legacy_path: "/admin#/gateway-mcp",
        status: "preview",
        risk_level: "medium",
        required_permission: "admin:read",
        read_only: false,
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
  const original = {
    id: "public-contract",
    namespace: "gateway",
    name: "gateway_chat",
    title: "공개 계약",
    description: "공개 설명",
    input_schema: '{"type":"object"}',
    output_schema: '{"type":"object","properties":{"answer":{"type":"string"}}}',
    risk_level: "medium",
    timeout_ms: 1000,
    allowed_roles: "",
    cost_policy: "",
    owner: "공개 담당",
    enabled: true,
    created_by: "public-admin",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  };
  const state = {
    rows: [{ ...original }],
    reads: 0,
    conflict: false,
    malformed: false,
    validation: "not_checkable",
  };
  const writes: { method: string; body: unknown }[] = [],
    unexpected: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname.startsWith("/app/")) return route.continue();
    const json = (body: unknown) => route.fulfill({ json: body });
    if (url.pathname === "/auth/me") return json({ authenticated: true, user });
    if (url.pathname === "/admin/ui-bootstrap") return json(bootstrap);
    if (url.pathname === "/health") return json({ status: "ok" });
    if (url.pathname === "/admin/gateway-mcp/info")
      return json({
        endpoint: "/mcp/gateway",
        protocol_version: "2025-06-18",
        tools: [],
        contracts: [],
        resources: [],
        prompts: [],
        note: "",
      });
    if (url.pathname === "/admin/mcp/contracts") {
      if (request.method() === "GET") {
        state.reads++;
        if (state.malformed) return json({ contracts: [{ id: original.id }] });
        return json({
          contracts: state.rows.map((row) =>
            state.conflict && state.reads > 1 ? { ...row, owner: "다른 담당" } : row,
          ),
        });
      }
      if (request.method() === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        writes.push({ method: "POST", body });
        state.rows = [{ ...original, ...body }];
        return json({ id: original.id, ok: true });
      }
      if (request.method() === "DELETE") {
        writes.push({ method: "DELETE", body: url.searchParams.get("id") });
        state.rows = [];
        return json({ ok: true });
      }
    }
    if (url.pathname === "/admin/mcp/contracts/validate")
      return json({
        checked: 1,
        drift_count: 0,
        missing_count: 0,
        note: "",
        results: [
          {
            contract_id: original.id,
            namespace: "external",
            name: original.name,
            risk_level: "medium",
            status: state.validation,
          },
        ],
      });
    unexpected.push(url.pathname);
    return route.fulfill({ status: 500, json: {} });
  });
  return { state, original, writes, unexpected, user, bootstrap };
}
async function edit(page: Page) {
  await page.goto("/app/mcp-gateway");
  await page.getByRole("button", { name: "수정", exact: true }).click();
  return page.getByRole("dialog", { name: "도구 계약", exact: true });
}
test("출력 선언 보존과 변경 비교·갱신 후 초점 복귀", async ({ page }) => {
  const fixture = await install(page);
  const dialog = await edit(page);
  const submit = dialog.getByRole("button", { name: "검토한 계약 저장", exact: true });
  await expect(submit).toBeDisabled();
  await expect(dialog.getByLabel("출력 스키마 (JSON)", { exact: true })).toHaveValue(
    fixture.original.output_schema,
  );
  await dialog.getByLabel("담당", { exact: true }).fill("새 담당");
  await expect(dialog.getByRole("region", { name: "계약 변경 비교" })).toContainText("새 담당");
  await submit.dblclick();
  await expect(dialog).toHaveCount(0);
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.writes[0]?.body).toMatchObject({
    id: fixture.original.id,
    owner: "새 담당",
    output_schema: fixture.original.output_schema,
  });
  await expect(page.getByRole("button", { name: "수정", exact: true })).toBeFocused();
  await page.reload();
  await page.getByRole("button", { name: "수정", exact: true }).click();
  await expect(dialog.getByLabel("출력 스키마 (JSON)", { exact: true })).toHaveValue(
    fixture.original.output_schema,
  );
  expect(fixture.unexpected).toEqual([]);
});
test("이름 재입력 후 정확한 ID만 삭제한다", async ({ page }) => {
  const fixture = await install(page);
  await page.goto("/app/mcp-gateway");
  await page.getByRole("button", { name: "삭제", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "도구 계약을 삭제할까요?", exact: true });
  const submit = dialog.getByRole("button", { name: "검토한 계약 삭제", exact: true });
  await expect(submit).toBeDisabled();
  await dialog.getByLabel(/확인 문구/).fill(fixture.original.name);
  await submit.click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.writes).toEqual([{ method: "DELETE", body: fixture.original.id }]);
  await expect(page.getByText("등록된 도구 계약이 없습니다.", { exact: true })).toBeVisible();
});
test("다른 관리자가 변경한 계약은 덮어쓰지 않는다", async ({ page }) => {
  const fixture = await install(page);
  fixture.state.conflict = true;
  const dialog = await edit(page);
  await dialog.getByLabel("담당", { exact: true }).fill("내 초안");
  await dialog.getByRole("button", { name: "검토한 계약 저장", exact: true }).click();
  await expect(dialog.getByText(/계약이 변경되거나 삭제되었습니다/)).toBeVisible();
  await expect(dialog.getByLabel("담당", { exact: true })).toHaveValue("내 초안");
  expect(fixture.writes).toEqual([]);
});
test("불완전 응답을 정상 빈 목록으로 표시하지 않는다", async ({ page }) => {
  const fixture = await install(page);
  fixture.state.malformed = true;
  await page.goto("/app/mcp-gateway");
  await expect(page.getByRole("alert")).toContainText("서버 응답 형식");
  await expect(page.getByText("등록된 도구 계약이 없습니다.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "계약 등록", exact: true })).toBeDisabled();
});
test("읽기 전용 검증에서 검증 불가와 알 수 없는 상태를 구분한다", async ({ page }) => {
  const fixture = await install(page),
    feature = fixture.bootstrap.migration_registry[0];
  if (!feature) throw new Error("fixture feature missing");
  feature.read_only = true;
  await page.goto("/app/mcp-gateway");
  await expect(page.getByRole("button", { name: "계약 등록", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "드리프트 검증", exact: true }).click();
  await expect(page.getByText("검증 불가", { exact: true })).toBeVisible();
  fixture.state.validation = "future";
  await page.getByRole("button", { name: "드리프트 검증", exact: true }).click();
  await expect(page.getByText("알 수 없는 결과", { exact: true })).toBeVisible();
  expect(fixture.writes).toEqual([]);
});
test("계약 조회 권한이 없으면 해당 API를 호출하지 않는다", async ({ page }) => {
  const fixture = await install(page);
  fixture.user.scopes = ["admin:read"];
  fixture.bootstrap.permissions = fixture.user.scopes;
  await page.goto("/app/mcp-gateway");
  await expect(page.getByText("/mcp/gateway", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "계약 등록", exact: true })).toHaveCount(0);
  expect(fixture.state.reads).toBe(0);
});
test("390px 어두운 계약 편집에서 고정 작업·키보드·접근성을 유지한다", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await install(page);
  const dialog = await edit(page);
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  const violations = await page.evaluate(async () =>
    (await (window as unknown as { axe: typeof axe }).axe.run()).violations.map((item) => item.id),
  );
  expect(violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(dialog.getByRole("button", { name: "취소", exact: true })).toBeInViewport();
  await dialog.getByLabel("도구 이름", { exact: false }).focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "수정", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mcp-contract-mobile.png"), fullPage: true });
});
