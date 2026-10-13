import { expect, test, type Page } from "@playwright/test";

import type { UiBootstrapResponse } from "../../src/shared/api/generated";

async function installGateway(page: Page) {
  const user = {
    id: "usr_role_labels",
    email: "role-labels@example.invalid",
    name: "역할 표시 검증",
    role: "admin",
    roles: ["admin"],
    scopes: ["admin:read", "admin:write"],
    team_id: "",
  };
  const bootstrap: UiBootstrapResponse = {
    backend_version: "v0.86.61",
    ui_version: "role-labels-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/access/users",
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
    allowed_features: ["access.users"],
    capabilities: { raw_prompt_view: false },
    migration_registry: [
      {
        feature_id: "access.users",
        title: "사용자와 팀",
        app_path: "/app/access/users",
        legacy_path: "/admin#/users",
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
    legacy_route_map: { "/app/access/users": "/admin#/users" },
  };
  const writes: { method: string; path: string; body: unknown }[] = [];
  const unexpected: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/app/")) return route.continue();
    const key = `${request.method()} ${url.pathname}`;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (key === "GET /auth/me") return json({ authenticated: true, user });
    if (key === "GET /health") return json({ status: "ok" });
    if (key === "GET /admin/ui-bootstrap") return json(bootstrap);
    if (key === "GET /admin/users")
      return json({
        auth_users: [{ ...user, role: "ops_admin", status: "active", created_at: "2026-10-01T00:00:00Z" }],
        users: [],
        team_names: {},
      });
    if (key === "GET /admin/benchmark/users") return json({ users: [] });
    if (key === "GET /admin/roles")
      return json({
        roles: [
          { role: "ops_admin", is_system: true, rank: 70, scopes: [], description: "", default_home: "" },
          {
            role: "custom_reviewer",
            is_system: false,
            rank: 0,
            scopes: [],
            description: "검토 담당",
            default_home: "",
          },
        ],
        all_scopes: [],
      });
    if (key === "POST /admin/users" || key === "PATCH /admin/users/usr_role_labels") {
      writes.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() });
      return json({ user });
    }
    unexpected.push(key);
    return route.fulfill({ status: 500, json: { error: "unexpected fixture request" } });
  });
  return { writes, unexpected };
}

test("한글 역할 선택·키보드 취소·기존 코드 전송과 역할 식별자를 보존한다", async ({ page }) => {
  const gateway = await installGateway(page);
  await page.goto("/app/access/users");
  const accounts = page.getByRole("table", { name: "로그인 계정 목록" });
  await expect(accounts.getByText("운영 관리자", { exact: true })).toBeVisible();
  const trigger = page.getByRole("button", { name: "역할·상태 변경" });
  await trigger.click();
  let dialog = page.getByRole("dialog", { name: "사용자 변경" });
  await expect(dialog.getByRole("combobox", { name: "역할", exact: true })).toHaveValue("ops_admin");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  dialog = page.getByRole("dialog", { name: "사용자 변경" });
  await dialog.getByRole("combobox", { name: "역할", exact: true }).selectOption({ label: "조회자" });
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(() => gateway.writes.length).toBe(1);
  expect(gateway.writes[0]).toEqual({
    method: "PATCH",
    path: "/admin/users/usr_role_labels",
    body: { role: "viewer", status: "active", team_id: "" },
  });
  await page.getByRole("tab", { name: "역할", exact: true }).click();
  const roles = page.getByRole("table", { name: "역할 목록" });
  const builtIn = roles.getByRole("row").filter({ hasText: "ops_admin" });
  await expect(builtIn.getByText("운영 관리자", { exact: true })).toBeVisible();
  await expect(builtIn.getByRole("button", { name: "수정", exact: true })).toBeDisabled();
  const custom = roles.getByRole("row").filter({ hasText: "custom_reviewer" });
  await expect(custom.getByText("사용자 정의", { exact: true })).toBeVisible();
  await expect(custom.getByRole("button", { name: "수정", exact: true })).toBeEnabled();
  const customTrigger = custom.getByRole("button", { name: "수정", exact: true });
  await customTrigger.click();
  await expect(page.getByRole("dialog", { name: "역할 수정" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(customTrigger).toBeFocused();
  expect(gateway.unexpected).toEqual([]);
});

test("좁은 화면에서도 등록 역할 선택지를 한글로 읽고 선택할 수 있다", async ({ page }) => {
  const gateway = await installGateway(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await page.goto("/app/access/users");
  await page.getByRole("button", { name: "사용자 등록", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "사용자 등록" });
  const role = dialog.getByRole("combobox", { name: "역할", exact: true });
  await role.scrollIntoViewIfNeeded();
  await expect(role.getByRole("option", { name: "개발자", exact: true })).toHaveAttribute(
    "value",
    "developer",
  );
  await role.selectOption({ label: "운영 관리자" });
  await expect(role).toHaveValue("ops_admin");
  const bounds = await role.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) throw new Error("역할 선택지가 표시되지 않습니다.");
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(async () => {
      const axe = (
        window as unknown as { axe: { run(root: Document): Promise<{ violations: { id: string }[] }> } }
      ).axe;
      return (await axe.run(document)).violations.map((violation) => violation.id);
    }),
  ).toEqual([]);
  expect(gateway.writes).toEqual([]);
  expect(gateway.unexpected).toEqual([]);
});
