import { expect, test, type Page } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

async function install(page: Page) {
  const user = {
    id: "public-mcp-reader",
    email: "mcp@example.invalid",
    name: "MCP 설정 검증",
    role: "admin",
    roles: ["admin"],
    team_id: "",
    scopes: ["observability:read", "mcp:admin"],
  };
  const bootstrap: UiBootstrapResponse = {
    backend_version: "v0.86.61",
    ui_version: "mcp-risk-fixture",
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
        status: "preview",
        risk_level: "medium",
        required_permission: "observability:read",
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
  let current = {
    server_label: "public-server",
    tool_name: "write_item",
    access_class: "write",
    risk_level: "high",
    action: "require_approval",
    recommended_action: "require_approval",
    configured: true,
    note: "원래 메모",
  };
  let changed = false;
  let heldRead: Promise<void> | undefined;
  let releaseRead = () => {};
  const writes: unknown[] = [];
  const unexpected: string[] = [];
  let preflights = 0;
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/app/")) return route.continue();
    const json = (body: unknown) => route.fulfill({ json: body });
    if (url.pathname === "/auth/me") return json({ authenticated: true, user });
    if (url.pathname === "/admin/ui-bootstrap") return json(bootstrap);
    if (url.pathname === "/health") return json({ status: "ok" });
    if (url.pathname === "/admin/mcp/tools") {
      if (request.method() === "POST") {
        const body = request.postDataJSON() as typeof current;
        writes.push(body);
        current = { ...current, ...body };
        return route.fulfill({ status: 201, json: { profile: { ...current, id: "public-profile" } } });
      }
      if (url.searchParams.has("server")) {
        preflights++;
        await heldRead;
      }
      return json({
        tools: [],
        tool_risk: [{ ...current, note: changed ? "다른 관리자" : current.note }],
        risk_profiles: [],
        count: 1,
      });
    }
    if (request.method() === "GET") {
      if (url.pathname === "/admin/mcp/servers") return json({ servers: [] });
      if (url.pathname === "/admin/mcp/catalog") return json({ catalog: [], new_count: 0 });
      if (url.pathname === "/admin/mcp/trust-scores") return json({ tools: [] });
    }
    unexpected.push(request.method() + " " + url.pathname);
    return route.fulfill({ status: 500 });
  });
  return {
    writes,
    unexpected,
    preflights: () => preflights,
    conflict: () => {
      changed = true;
    },
    readonly: () => {
      const feature = bootstrap.migration_registry?.[0];
      if (feature) feature.read_only = true;
    },
    unknown: () => {
      current.risk_level = "future-level";
      current.action = "future-action";
    },
    hold: () => {
      heldRead = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
    },
    release: () => releaseRead(),
  };
}
async function open(page: Page) {
  await page.goto("/app/mcp?tab=tools");
  await page.getByRole("button", { name: "public-server write_item 위험 등급 편집", exact: true }).click();
  return page.getByRole("dialog", { name: "도구 위험 등급", exact: true });
}
async function runtime(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}

test("한글 비교와 저장 직전 확인 후 선택한 도구만 변경한다", async ({ page }) => {
  const fixture = await install(page);
  const dialog = await open(page);
  const save = dialog.getByRole("button", { name: "검토한 변경 저장", exact: true });
  await expect(save).toBeDisabled();
  await dialog.getByLabel(/^위험 등급/).selectOption("critical");
  await dialog.getByLabel("메모", { exact: true }).fill("새 메모");
  await expect(dialog.getByText("변경 전: 높음", { exact: true })).toBeVisible();
  await expect(dialog.getByText("변경 후: 심각", { exact: true })).toBeVisible();
  await save.click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.preflights()).toBe(1);
  expect(fixture.writes).toEqual([
    {
      server_label: "public-server",
      tool_name: "write_item",
      risk_level: "critical",
      action: "require_approval",
      note: "새 메모",
    },
  ]);
  expect(fixture.unexpected).toEqual([]);
});
test("미지원 현재 값을 보존하고 명시적인 선택을 요구한다", async ({ page }) => {
  const fixture = await install(page);
  fixture.unknown();
  const dialog = await open(page);
  await expect(dialog.getByLabel(/^위험 등급/)).toHaveValue("future-level");
  await expect(dialog.getByLabel(/^조치/)).toHaveValue("future-action");
  await dialog.getByLabel("메모", { exact: true }).fill("새 메모");
  const save = dialog.getByRole("button", { name: "검토한 변경 저장", exact: true });
  await expect(save).toBeDisabled();
  await dialog.getByLabel(/^위험 등급/).selectOption("high");
  await dialog.getByLabel(/^조치/).selectOption("block");
  await expect(save).toBeEnabled();
  expect(fixture.writes).toEqual([]);
});
test("편집 이후 변경된 설정은 덮어쓰지 않는다", async ({ page }) => {
  const fixture = await install(page);
  const dialog = await open(page);
  await dialog.getByLabel("메모", { exact: true }).fill("내 초안");
  fixture.conflict();
  await dialog.getByRole("button", { name: "검토한 변경 저장", exact: true }).click();
  await expect(dialog.getByText("현재 설정을 다시 확인하세요.", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("메모", { exact: true })).toHaveValue("내 초안");
  await expect(dialog.getByRole("button", { name: "검토한 변경 저장", exact: true })).toBeDisabled();
  expect(fixture.writes).toEqual([]);
});
test("읽기 전용 변경 후에도 초안을 보존하고 직접 제출을 차단한다", async ({ page }) => {
  const fixture = await install(page);
  const dialog = await open(page);
  await dialog.getByLabel("메모", { exact: true }).fill("보존할 초안");
  fixture.readonly();
  await runtime(page);
  await expect(dialog.getByLabel("메모", { exact: true })).toHaveValue("보존할 초안");
  await expect(dialog.getByRole("button", { name: "검토한 변경 저장", exact: true })).toBeDisabled();
  await dialog.locator("form").evaluate((form) => (form as HTMLFormElement).requestSubmit());
  expect(fixture.writes).toEqual([]);
});
test("저장 직전 조회 중 읽기 전용으로 바뀌면 실제 저장하지 않는다", async ({ page }) => {
  const fixture = await install(page);
  const dialog = await open(page);
  await dialog.getByLabel("메모", { exact: true }).fill("검토 중인 초안");
  fixture.hold();
  await dialog.getByRole("button", { name: "검토한 변경 저장", exact: true }).click();
  await expect.poll(fixture.preflights).toBe(1);
  fixture.readonly();
  await runtime(page);
  fixture.release();
  await expect(dialog.getByRole("button", { name: "검토한 변경 저장", exact: true })).toBeDisabled();
  await expect(dialog.getByText("지금은 저장할 수 없습니다.", { exact: true })).toBeVisible();
  expect(fixture.writes).toEqual([]);
});
test("모바일 어두운 검토창에서 키보드·고정 저장 버튼·긴 메모를 검증한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  const fixture = await install(page);
  const dialog = await open(page);
  await dialog.getByLabel("메모", { exact: true }).fill("긴검토메모".repeat(60));
  const save = dialog.getByRole("button", { name: "검토한 변경 저장", exact: true });
  await save.focus();
  await expect(save).toBeFocused();
  await expect(save).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await dialog.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
    }),
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
  await page.screenshot({ path: test.info().outputPath("mcp-risk-mobile.png"), fullPage: true });
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
});
