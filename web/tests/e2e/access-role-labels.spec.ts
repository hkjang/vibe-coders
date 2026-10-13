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
  let roleNames = ["developer", "viewer", "ops_admin", "custom_reviewer"];
  let roleReads = 0;
  let roleStatus = 200;
  let writeStatus = 200;
  let writeHold: Promise<void> | undefined;
  let releaseWrite = () => undefined;
  const roleHolds = new Map<number, { promise: Promise<void>; release: () => void }>();
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
    if (key === "GET /admin/roles") {
      roleReads++;
      const roles = roleNames.map((role) => ({
        role,
        is_system: role !== "custom_reviewer",
        rank: role === "custom_reviewer" ? 0 : 2,
        scopes: [],
        description: "",
        default_home: "",
      }));
      await roleHolds.get(roleReads)?.promise;
      if (roleStatus !== 200)
        return route.fulfill({ status: roleStatus, json: { error: { message: "private fixture failure" } } });
      return json({
        roles,
        all_scopes: [],
      });
    }
    if (key === "POST /admin/users" || key === "PATCH /admin/users/usr_role_labels") {
      writes.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() });
      await writeHold;
      if (writeStatus !== 200)
        return route.fulfill({
          status: writeStatus,
          json: { error: { message: "private stale write failure" } },
        });
      return json({ user });
    }
    unexpected.push(key);
    return route.fulfill({ status: 500, json: { error: "unexpected fixture request" } });
  });
  return {
    writes,
    unexpected,
    holdWrite: (status: number) => {
      writeStatus = status;
      writeHold = new Promise<void>((resolve) => {
        releaseWrite = () => {
          resolve();
          return undefined;
        };
      });
    },
    releaseWrite: () => releaseWrite(),
    revokeWrite: (kind: string) => {
      if (kind === "readonly") {
        for (const feature of bootstrap.migration_registry) feature.read_only = true;
      } else user.scopes = ["admin:read"];
    },
    roleReads: () => roleReads,
    roles: (value: string[]) => {
      roleNames = value;
    },
    roleStatus: (value: number) => {
      roleStatus = value;
    },
    owner: (id: string) => {
      user.id = id;
    },
    hold: (number: number) => {
      let release = () => undefined;
      const promise = new Promise<void>((done) => {
        release = () => {
          done();
          return undefined;
        };
      });
      roleHolds.set(number, { promise, release });
    },
    release: (number: number) => roleHolds.get(number)?.release(),
  };
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

test("사용자 정의 역할을 저장 전 재조회하고 삭제된 역할의 자동 대체를 막는다", async ({ page }) => {
  const gateway = await installGateway(page);
  await page.goto("/app/access/users");
  await page.getByRole("button", { name: "역할·상태 변경", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "사용자 변경" });
  const role = dialog.getByRole("combobox", { name: "역할", exact: true });
  await role.selectOption("custom_reviewer");
  gateway.roles(["developer", "viewer"]);
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(
    dialog.getByText("선택한 역할이 목록에 없습니다. 다른 역할을 명시적으로 선택하세요."),
  ).toBeVisible();
  expect(gateway.writes).toHaveLength(0);
  expect(gateway.roleReads()).toBe(2);
  await expect(role).toHaveValue("custom_reviewer");
  await role.selectOption("viewer");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(() => gateway.writes.length).toBe(1);
  expect(gateway.roleReads()).toBe(3);
  expect(gateway.writes[0]?.body).toEqual({ role: "viewer", status: "active", team_id: "" });
  expect(gateway.unexpected).toEqual([]);
});

test("역할 목록 실패 후 초안을 보존하며 수동 재조회로 사용자 정의 역할 등록을 복구한다", async ({ page }) => {
  const gateway = await installGateway(page);
  gateway.roleStatus(503);
  await page.goto("/app/access/users");
  await page.getByRole("button", { name: "사용자 등록", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "사용자 등록" });
  await expect(dialog.getByText("역할 목록을 불러오지 못했습니다.")).toBeVisible();
  await dialog.getByRole("textbox", { name: "이메일", exact: true }).fill("catalog@example.invalid");
  await dialog.getByLabel("비밀번호", { exact: false }).fill("synthetic-password");
  await expect(dialog.getByRole("button", { name: "등록", exact: true })).toBeDisabled();
  gateway.roleStatus(200);
  await dialog.getByRole("button", { name: "역할 목록 다시 조회" }).click();
  await dialog.getByRole("combobox", { name: "역할", exact: true }).selectOption("custom_reviewer");
  await dialog.getByRole("button", { name: "등록", exact: true }).click();
  await expect.poll(() => gateway.writes.length).toBe(1);
  expect(gateway.writes[0]?.body).toEqual({
    email: "catalog@example.invalid",
    password: "synthetic-password",
    role: "custom_reviewer",
  });
  expect(gateway.roleReads()).toBe(3);
  expect(gateway.unexpected).toEqual([]);
});

test("계정 변경은 저장 전 역할 조회를 취소하고 이전 계정의 초안과 쓰기를 폐기한다", async ({ page }) => {
  const gateway = await installGateway(page);
  gateway.hold(2);
  await page.goto("/app/access/users");
  await page.getByRole("button", { name: "역할·상태 변경", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "사용자 변경" });
  await dialog.getByRole("combobox", { name: "역할", exact: true }).selectOption("custom_reviewer");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(() => gateway.roleReads()).toBe(2);
  const canceled = page.waitForEvent(
    "requestfailed",
    (request) => new URL(request.url()).pathname === "/admin/roles",
  );
  gateway.owner("usr_next_operator");
  const refreshed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/admin/ui-bootstrap",
  );
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await refreshed).finished();
  await canceled;
  await expect(dialog).toBeHidden();
  gateway.release(2);
  expect(gateway.writes).toHaveLength(0);
  expect(gateway.unexpected).toEqual([]);
});

for (const kind of ["readonly", "scope"]) {
  for (const status of [200, 503]) {
    test(`계정 저장 전송 후 ${kind} 변경이면 ${status} 완료로 창을 닫거나 알리지 않는다`, async ({
      page,
    }) => {
      const gateway = await installGateway(page);
      gateway.holdWrite(status);
      await page.goto("/app/access/users");
      await page.getByRole("button", { name: "역할·상태 변경", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "사용자 변경" });
      const role = dialog.getByRole("combobox", { name: "역할", exact: true });
      await role.selectOption("custom_reviewer");
      await dialog.getByRole("button", { name: "저장", exact: true }).click();
      await expect.poll(() => gateway.writes.length).toBe(1);
      gateway.revokeWrite(kind);
      const refreshed = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/admin/ui-bootstrap",
      );
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await (await refreshed).finished();
      await expect(
        dialog.getByText(kind === "readonly" ? /이 화면은 읽기 전용/ : /변경 권한/).first(),
      ).toBeVisible();
      const finished = page.waitForResponse((response) => response.request().method() === "PATCH");
      gateway.releaseWrite();
      await (await finished).finished();
      await expect(role).toBeEnabled();
      await expect(dialog).toBeVisible();
      await expect(role).toHaveValue("custom_reviewer");
      await expect(dialog.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
      await expect(page.getByText("private stale write failure")).toHaveCount(0);
      expect(gateway.writes).toHaveLength(1);
      expect(gateway.unexpected).toEqual([]);
    });
  }
}
