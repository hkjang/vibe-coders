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
  let invalidCatalog = false;
  const descriptions = new Map<string, string>();
  const teams = new Map([
    [
      "team_fixture",
      {
        id: "team_fixture",
        name: "기존 검증 팀",
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-01T00:00:00Z",
      },
    ],
  ]);
  let teamStatus = 200;
  const roleScopes = new Map<string, string[]>();
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
    if (key === "GET /admin/teams")
      return teamStatus === 200
        ? json({ teams: [], auth_teams: [...teams.values()] })
        : route.fulfill({
            status: teamStatus,
            json: { error: { code: "auth_teams_failed", message: "private fixture failure" } },
          });
    if (key === "GET /admin/teams/scorecard" || key === "GET /admin/benchmark/teams")
      return json({ teams: [] });
    if (key === "POST /admin/teams") {
      const body = request.postDataJSON() as { id: string; name: string };
      writes.push({ method: "POST", path: url.pathname, body });
      await writeHold;
      const previous = teams.get(body.id);
      const team = {
        ...body,
        created_at: previous?.created_at ?? "2026-10-01T00:00:00Z",
        updated_at: "2026-10-14T00:00:00Z",
      };
      teams.set(body.id, team);
      return json({ team });
    }
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
        is_system: ["developer", "viewer", "ops_admin"].includes(role),
        rank: ["developer", "viewer", "ops_admin"].includes(role) ? 2 : 0,
        ...(invalidCatalog
          ? {}
          : {
              scopes:
                roleScopes.get(role) ??
                (role === "developer"
                  ? ["models:read", "chat:completion"]
                  : role === "custom_reviewer"
                    ? ["future:review"]
                    : ["models:read"]),
            }),
        description: descriptions.get(role) ?? "",
        default_home: "",
      }));
      await roleHolds.get(roleReads)?.promise;
      if (roleStatus !== 200)
        return route.fulfill({ status: roleStatus, json: { error: { message: "private fixture failure" } } });
      return json({
        roles,
        all_scopes: ["models:read", "chat:completion", "admin:write"],
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
    if (key === "POST /admin/roles" || key === "DELETE /admin/roles") {
      const body =
        request.method() === "POST"
          ? (request.postDataJSON() as { role: string; scopes: string[]; description?: string })
          : undefined;
      writes.push({ method: request.method(), path: url.pathname, body });
      await writeHold;
      if (writeStatus !== 200)
        return route.fulfill({
          status: writeStatus,
          json: { error: { message: "private stale role failure" } },
        });
      if (body) {
        roleNames = [...new Set([...roleNames, body.role])];
        roleScopes.set(body.role, body.scopes);
        descriptions.set(body.role, body.description ?? "");
        return json({ role: body });
      }
      roleNames = roleNames.filter((role) => role !== url.searchParams.get("role"));
      return json({ deleted: true });
    }
    unexpected.push(key);
    return route.fulfill({ status: 500, json: { error: "unexpected fixture request" } });
  });
  return {
    writes,
    teamStatus: (status: number) => {
      teamStatus = status;
    },
    addTeam: (id: string, name: string) =>
      teams.set(id, { id, name, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }),
    renameTeam: (name: string) => {
      const team = teams.get("team_fixture");
      if (team) team.name = name;
    },
    describeRole: (role: string, description: string) => descriptions.set(role, description),
    unexpected,
    invalidCatalog: (value: boolean) => {
      invalidCatalog = value;
    },
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

async function installUserUsage(page: Page) {
  let status = 200;
  let promoted = false;
  let reads = 0;
  const writes: unknown[] = [];
  let held: Promise<void> | undefined;
  let release = () => {};
  await page.route("**/admin/users", async (route) => {
    reads++;
    return status === 200
      ? route.fulfill({
          json: {
            auth_users: [
              {
                id: "usr_owned",
                email: "owned@example.invalid",
                name: "조회 소유 계정",
                role: "developer",
                status: "active",
              },
            ],
            users: [
              {
                api_key_id: "key_external",
                name: "조회 소유 키",
                owner: "소유 팀",
                team: "team_a",
                status: promoted ? "active" : "external",
              },
            ],
            team_names: {},
          },
        })
      : route.fulfill({
          status,
          json: { error: { code: "server_error", message: "private fixture failure" } },
        });
  });
  await page.route("**/admin/api-keys/key_external", async (route) => {
    writes.push(route.request().postDataJSON());
    await held;
    promoted = true;
    return route.fulfill({ json: { id: "key_external", status: "active" } });
  });
  return {
    reads: () => reads,
    writes,
    status: (value: number) => {
      status = value;
    },
    hold: () => {
      held = new Promise<void>((done) => {
        release = done;
      });
    },
    release: () => release(),
  };
}

test("사용자 목록 장애는 0건으로 표시하지 않고 목록만 다시 조회한다", async ({ page }) => {
  const gateway = await installGateway(page);
  const fixture = await installUserUsage(page);
  fixture.status(500);
  await page.goto("/app/access/users");
  await expect(page.getByText("사용자 목록을(를) 불러오지 못했습니다.")).toBeVisible();
  await expect(page.getByRole("table", { name: "로그인 계정 목록", exact: true })).toHaveCount(0);
  fixture.status(200);
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.getByText("owned@example.invalid", { exact: true })).toBeVisible();
  expect(fixture.writes).toEqual([]);
  expect(gateway.unexpected).toEqual([]);
});

test("사용자 활용지수 권한 오류는 이전 목록을 숨기고 명시적으로 조회를 재개한다", async ({ page }) => {
  const gateway = await installGateway(page);
  const fixture = await installUserUsage(page);
  let reject = false;
  await page.route("**/admin/benchmark/users?*", (route) =>
    reject
      ? route.fulfill({
          status: 403,
          json: { error: { code: "permission_denied", message: "private fixture failure" } },
        })
      : route.fulfill({ json: { users: [] } }),
  );
  await page.goto("/app/access/users");
  await expect(page.getByText("owned@example.invalid", { exact: true })).toBeVisible();
  reject = true;
  await page.getByRole("combobox", { name: "기간", exact: true }).selectOption("7d");
  await expect(page.getByText("사용자 조회 권한을 다시 확인하세요.")).toBeVisible();
  await expect(page.getByText("owned@example.invalid", { exact: true })).toHaveCount(0);
  reject = false;
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.getByText("owned@example.invalid", { exact: true })).toBeVisible();
  expect(fixture.writes).toEqual([]);
  expect(gateway.unexpected).toEqual([]);
});

test("계정 전환은 보류 중인 사용자 상세와 목록을 폐기한다", async ({ page }) => {
  const gateway = await installGateway(page);
  await installUserUsage(page);
  let release = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  await page.route("**/admin/users/key_external?*", async (route) => {
    await held;
    await route.fulfill({ json: { api_key: { name: "이전 상세 원문" } } }).catch(() => {});
  });
  await page.route("**/admin/users/key_external/report?*", (route) => route.fulfill({ json: {} }));
  await page.goto("/app/access/users");
  await page.getByRole("button", { name: "조회 소유 키 상세 열기" }).click();
  await expect(page.getByRole("dialog", { name: "사용자 상세", exact: true })).toBeVisible();
  gateway.owner("usr_new_owner");
  const refreshed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/admin/ui-bootstrap",
  );
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await refreshed).finished();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  release();
  await expect(page.getByText("이전 상세 원문", { exact: true })).toHaveCount(0);
  expect(gateway.unexpected).toEqual([]);
});

for (const kind of ["readonly", "scope"]) {
  test(`관리 키 등록 뒤 ${kind} 회수는 늦은 성공을 현재 작업 완료로 알리지 않는다`, async ({ page }) => {
    const gateway = await installGateway(page);
    const fixture = await installUserUsage(page);
    fixture.hold();
    await page.goto("/app/access/users");
    await page.getByRole("button", { name: "관리 키로 등록", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "관리 키로 등록", exact: true });
    await dialog.getByRole("button", { name: "등록", exact: true }).click();
    await expect.poll(() => fixture.writes.length).toBe(1);
    gateway.revokeWrite(kind);
    const refreshed = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/admin/ui-bootstrap",
    );
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await (await refreshed).finished();
    const reads = fixture.reads();
    fixture.release();
    await expect(dialog.getByRole("button", { name: "등록", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "취소", exact: true })).toBeEnabled();
    await expect(dialog).toBeVisible();
    await expect(page.getByText("외부 키를 관리 키로 등록했습니다.", { exact: true })).toHaveCount(0);
    expect(fixture.reads()).toBe(reads);
    expect(gateway.unexpected).toEqual([]);
  });
}

test("모바일 사용자 키 등록은 키보드 취소 초점과 접근성·실제 입력값을 유지한다", async ({
  page,
}, testInfo) => {
  const gateway = await installGateway(page);
  const fixture = await installUserUsage(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await page.goto("/app/access/users");
  const trigger = page.getByRole("button", { name: "관리 키로 등록", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "관리 키로 등록", exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  expect(
    await page.evaluate(async () =>
      (
        await (
          window as unknown as { axe: { run(root: Document): Promise<{ violations: { id: string }[] }> } }
        ).axe.run(document)
      ).violations.map((v) => v.id),
    ),
  ).toEqual([]);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("user-key-registration-mobile.png") });
  await dialog.getByRole("button", { name: "등록", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(fixture.writes).toEqual([{ status: "active", name: "조회 소유 키", team: "team_a" }]);
  expect(gateway.unexpected).toEqual([]);
});

test("팀 생성·이름 수정은 모바일 변경 비교·중복 방지·초점과 접근성을 유지한다", async ({
  page,
}, testInfo) => {
  const gateway = await installGateway(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await page.goto("/app/access/users?tab=teams");
  const createTrigger = page.getByRole("button", { name: "팀 추가", exact: true });
  await createTrigger.click();
  const create = page.getByRole("dialog", { name: "팀 추가", exact: true });
  const id = create.getByRole("textbox", { name: "팀 ID", exact: true });
  await expect(id).toHaveValue(/^team_[a-f0-9]{32}$/u);
  await id.fill("team_fixture");
  await create.getByRole("textbox", { name: "팀 이름", exact: true }).fill("새 검증 팀");
  await create.getByRole("button", { name: "저장", exact: true }).click();
  await expect(
    create.getByText("이미 등록된 팀 ID입니다. 목록의 이름 수정 기능을 이용하세요."),
  ).toBeVisible();
  expect(gateway.writes).toHaveLength(0);
  await id.fill("team_new");
  await expect(create.getByRole("region", { name: "팀 변경 전후 비교" })).toContainText(
    "변경 후 이름: 새 검증 팀",
  );
  await expect(create.getByRole("button", { name: "저장", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(
    await page.evaluate(async () =>
      (
        await (
          window as unknown as { axe: { run(root: Document): Promise<{ violations: { id: string }[] }> } }
        ).axe.run(document)
      ).violations.map((item) => item.id),
    ),
  ).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("team-editor-mobile.png") });
  await create.getByRole("button", { name: "저장", exact: true }).click();
  await expect(create).toBeHidden();
  await expect(createTrigger).toBeFocused();
  const row = page
    .getByRole("table", { name: "등록된 팀 목록", exact: true })
    .getByRole("row")
    .filter({ hasText: "team_new" });
  const editTrigger = row.getByRole("button", { name: "이름 수정" });
  await editTrigger.click();
  const edit = page.getByRole("dialog", { name: "팀 이름 수정" });
  await expect(edit.getByRole("textbox", { name: "팀 ID", exact: true })).toHaveAttribute("readonly");
  await edit.getByRole("textbox", { name: "팀 이름", exact: true }).fill("수정한 팀");
  await edit.getByRole("button", { name: "저장", exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(editTrigger).toBeFocused();
  expect(gateway.writes).toEqual([
    { method: "POST", path: "/admin/teams", body: { id: "team_new", name: "새 검증 팀" } },
    { method: "POST", path: "/admin/teams", body: { id: "team_new", name: "수정한 팀" } },
  ]);
  expect(gateway.unexpected).toEqual([]);
});

test("팀 이름 수정은 서버 변경을 발견하면 초안을 보존하고 저장하지 않는다", async ({ page }) => {
  const gateway = await installGateway(page);
  await page.goto("/app/access/users?tab=teams");
  await page.getByRole("button", { name: "이름 수정" }).click();
  const dialog = page.getByRole("dialog", { name: "팀 이름 수정" });
  await dialog.getByRole("textbox", { name: "팀 이름", exact: true }).fill("이전 초안");
  gateway.renameTeam("다른 관리자의 이름");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(
    dialog.getByText("팀이 변경되었거나 없어졌습니다. 편집창을 다시 열어 확인하세요."),
  ).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "팀 이름", exact: true })).toHaveValue("이전 초안");
  expect(gateway.writes).toHaveLength(0);
  expect(gateway.unexpected).toEqual([]);
});

for (const panel of [
  { path: "/admin/teams/scorecard", label: "팀 스코어카드", empty: "스코어카드를 계산할 데이터가 없습니다." },
  { path: "/admin/benchmark/teams", label: "팀 벤치마크", empty: "벤치마크 데이터가 없습니다." },
]) {
  test(`${panel.label} 로딩·장애·재시도한 빈 결과를 구분한다`, async ({ page }) => {
    const gateway = await installGateway(page);
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fail = true;
    await page.route(`**${panel.path}?*`, async (route) => {
      await hold;
      return fail
        ? route.fulfill({
            status: 500,
            json: { error: { code: "server_error", message: "private fixture failure" } },
          })
        : route.fulfill({ json: { teams: [] } });
    });
    await page.goto("/app/access/users?tab=teams");
    await expect(page.getByText(`${panel.label}를 불러오는 중입니다.`)).toBeVisible();
    await expect(page.getByText(panel.empty)).toHaveCount(0);
    release();
    await expect(page.getByText(`${panel.label}을(를) 불러오지 못했습니다.`)).toBeVisible();
    await expect(page.getByText(panel.empty)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "팀 추가", exact: true })).toBeEnabled();
    fail = false;
    await page.getByRole("button", { name: "다시 시도", exact: true }).click();
    await expect(page.getByText(panel.empty)).toBeVisible();
    await expect(page.getByText(`${panel.label}을(를) 불러오지 못했습니다.`)).toHaveCount(0);
    expect(gateway.writes).toEqual([]);
    expect(gateway.unexpected).toEqual([]);
  });
}

test("긴 기존 팀 ID를 유지해 수정하고 보호된 ID는 다른 팀을 가리지 않는다", async ({ page }) => {
  const gateway = await installGateway(page);
  const longId = `legacy_team_${"x".repeat(1024)}`;
  const protectedId = `vc_sk_${"a".repeat(43)}`;
  gateway.addTeam(longId, "긴 기존 팀");
  gateway.addTeam(protectedId, "보호 대상 팀");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/access/users?tab=teams");
  const table = page.getByRole("table", { name: "등록된 팀 목록", exact: true });
  await expect(table.getByText("기존 검증 팀", { exact: true })).toBeVisible();
  await expect(
    table.getByRole("row").filter({ hasText: "보호 대상 팀" }).getByRole("button", { name: "이름 수정" }),
  ).toBeDisabled();
  await expect(page.getByText(protectedId, { exact: true })).toHaveCount(0);
  await table
    .getByRole("row")
    .filter({ hasText: "긴 기존 팀" })
    .getByRole("button", { name: "이름 수정" })
    .click();
  const dialog = page.getByRole("dialog", { name: "팀 이름 수정" });
  await expect(dialog.getByRole("textbox", { name: "팀 ID", exact: true })).toHaveValue(longId);
  await dialog.getByRole("textbox", { name: "팀 이름", exact: true }).fill("긴 팀 수정");
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(gateway.writes).toEqual([
    { method: "POST", path: "/admin/teams", body: { id: longId, name: "긴 팀 수정" } },
  ]);
  expect(gateway.unexpected).toEqual([]);
});

test("팀 등록 조회 실패는 새 팀 저장을 허용하지 않는다", async ({ page }) => {
  const gateway = await installGateway(page);
  gateway.teamStatus(500);
  await page.goto("/app/access/users?tab=teams");
  await expect(page.getByRole("button", { name: "팀 추가", exact: true })).toBeDisabled();
  await expect(page.getByText("등록된 팀 목록을 불러오지 못했습니다. 다시 조회하세요.")).toBeVisible();
  expect(gateway.writes).toHaveLength(0);
});

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

test("읽기 전용 권한 비교의 한글 검색·차이 필터·네 역할·모바일 접근성과 초점을 검증한다", async ({
  page,
}, testInfo) => {
  const gateway = await installGateway(page);
  gateway.revokeWrite("readonly");
  gateway.revokeWrite("scope");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await page.goto("/app/access/users?tab=roles");
  const trigger = page.getByRole("button", { name: "권한 비교", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "역할별 권한 비교" });
  const table = dialog.getByRole("table");
  await expect(table).toBeVisible();
  await dialog.getByRole("combobox", { name: "비교 역할 3" }).selectOption("custom_reviewer");
  await dialog.getByRole("combobox", { name: "비교 역할 4" }).selectOption("ops_admin");
  await dialog.getByRole("checkbox", { name: "차이가 있는 권한만" }).check();
  await expect(table.getByRole("row", { name: /future:review/ })).toContainText("부여됨");
  const search = dialog.getByRole("textbox", { name: "권한 검색" });
  await search.fill("대화");
  await expect(table).toContainText("대화 생성");
  await expect(table).not.toContainText("모델 조회");
  expect(page.url()).not.toContain(encodeURIComponent("대화"));
  await dialog.getByRole("button", { name: "검색·필터 초기화" }).click();
  await expect(search).toBeFocused();
  const scroll = dialog.getByRole("region", { name: "역할별 권한 비교 표, 가로 스크롤 가능" });
  await scroll.focus();
  await expect(scroll).toBeFocused();
  expect(await scroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(dialog.getByRole("button", { name: "닫기", exact: true })).toBeInViewport();
  expect(
    await page.evaluate(async () => {
      const axe = (
        window as unknown as { axe: { run(root: Document): Promise<{ violations: { id: string }[] }> } }
      ).axe;
      return (await axe.run(document)).violations.map((violation) => violation.id);
    }),
  ).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("role-matrix-mobile.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(gateway.writes).toHaveLength(0);
  expect(gateway.unexpected).toEqual([]);
});

test("권한 비교 재조회 실패와 누락된 권한 계약을 빈 권한으로 표시하지 않는다", async ({ page }) => {
  const gateway = await installGateway(page);
  await page.goto("/app/access/users?tab=roles");
  await page.getByRole("button", { name: "권한 비교", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "역할별 권한 비교" });
  await expect(dialog.getByRole("table")).toBeVisible();
  gateway.roleStatus(503);
  await dialog.getByRole("button", { name: "목록 새로 조회" }).click();
  await expect(dialog.getByText("역할 목록을 확인하지 못했습니다. 목록을 다시 조회하세요.")).toBeVisible();
  await expect(dialog.getByRole("table")).toHaveCount(0);
  gateway.roleStatus(200);
  gateway.invalidCatalog(true);
  const malformed = page.waitForResponse((response) => new URL(response.url()).pathname === "/admin/roles");
  await dialog.getByRole("button", { name: "목록 새로 조회" }).click();
  await (await malformed).finished();
  await expect(dialog.getByText("역할 목록을 확인하지 못했습니다. 목록을 다시 조회하세요.")).toBeVisible();
  await expect(dialog.getByRole("table")).toHaveCount(0);
  gateway.invalidCatalog(false);
  await dialog.getByRole("button", { name: "목록 새로 조회" }).click();
  await expect(dialog.getByRole("table")).toBeVisible();
  expect(gateway.writes).toHaveLength(0);
  expect(gateway.unexpected).toEqual([]);
});

test("권한 비교의 대기 중 조회를 계정 변경 시 취소하고 늦은 권한을 표시하지 않는다", async ({ page }) => {
  const gateway = await installGateway(page);
  gateway.hold(2);
  await page.goto("/app/access/users?tab=roles");
  await expect(page.getByRole("table", { name: "역할 목록", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "권한 비교", exact: true }).click();
  await expect.poll(() => gateway.roleReads()).toBe(2);
  const canceled = page.waitForEvent(
    "requestfailed",
    (request) => new URL(request.url()).pathname === "/admin/roles",
  );
  gateway.owner("usr_next_matrix_reader");
  const refreshed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/admin/ui-bootstrap",
  );
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await refreshed).finished();
  await canceled;
  await expect(page.getByRole("dialog", { name: "역할별 권한 비교" })).toBeHidden();
  gateway.release(2);
  expect(gateway.writes).toHaveLength(0);
  expect(gateway.unexpected).toEqual([]);
});

test("역할 변경 비교는 입력·원복·모바일 접근성과 저장 전후 초점을 유지한다", async ({ page }, testInfo) => {
  const gateway = await installGateway(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await page.goto("/app/access/users?tab=roles");
  const row = page
    .getByRole("table", { name: "역할 목록", exact: true })
    .getByRole("row")
    .filter({ hasText: "custom_reviewer" });
  const trigger = row.getByRole("button", { name: "수정", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "역할 수정", exact: true });
  const review = dialog.getByRole("region", { name: "역할 변경 전후 비교", exact: true });
  await expect(review.getByText("변경된 항목이 없습니다.")).toBeVisible();
  const description = dialog.getByRole("textbox", { name: "설명", exact: true });
  await description.fill("긴 설명 ".repeat(30));
  const scope = dialog.getByRole("checkbox", { name: "관리 설정 변경 (admin:write)" });
  await scope.check();
  await expect(review.getByText("권한 추가 1개 · 제거 0개")).toBeVisible();
  await expect(review.getByRole("row", { name: "관리 설정 변경 (admin:write) 미부여 부여됨" })).toBeVisible();
  const scroll = review.getByRole("region", { name: "역할 변경 비교 표, 가로 스크롤 가능" });
  const beforeColumn = review.getByRole("columnheader", { name: "변경 전", exact: true });
  expect(
    await beforeColumn.evaluate((element) => element.getBoundingClientRect().width),
  ).toBeGreaterThanOrEqual(100);
  await scroll.focus();
  await expect(scroll).toBeFocused();
  expect(await scroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(dialog.getByRole("button", { name: "저장", exact: true })).toBeInViewport();
  expect(
    await page.evaluate(async () => {
      const axe = (
        window as unknown as { axe: { run(root: Document): Promise<{ violations: { id: string }[] }> } }
      ).axe;
      return (await axe.run(document)).violations.map((violation) => violation.id);
    }),
  ).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("role-change-review-mobile.png") });
  await scope.uncheck();
  await description.fill("");
  await expect(review.getByText("변경된 항목이 없습니다.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(gateway.writes).toEqual([]);
  expect(gateway.unexpected).toEqual([]);
});

test("역할 추가는 기존 이름의 덮어쓰기를 막고 새 이름과 한글 권한만 저장한다", async ({ page }) => {
  const gateway = await installGateway(page);
  await page.goto("/app/access/users?tab=roles");
  const trigger = page.getByRole("button", { name: "역할 추가", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "역할 추가", exact: true });
  const name = dialog.getByRole("textbox", { name: "역할 이름", exact: true });
  await name.fill("custom_reviewer");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog.getByText("이미 등록된 역할 이름입니다. 목록의 수정 기능을 이용하세요.")).toBeVisible();
  expect(gateway.writes).toHaveLength(0);
  await name.fill("new_reviewer");
  await dialog.getByRole("checkbox", { name: "모델 조회 (models:read)", exact: true }).check();
  await expect(dialog.getByRole("row", { name: "역할 이름 새 역할 new_reviewer" })).toBeVisible();
  await expect(dialog.getByRole("row", { name: "모델 조회 (models:read) 미부여 부여됨" })).toBeVisible();
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(gateway.writes).toEqual([
    { method: "POST", path: "/admin/roles", body: { role: "new_reviewer", scopes: ["models:read"] } },
  ]);
  await expect(trigger).toBeFocused();
  expect(gateway.unexpected).toEqual([]);
});

test("역할 수정은 최신 서버 변경을 감지하고 이전 초안을 보존한다", async ({ page }) => {
  const gateway = await installGateway(page);
  await page.goto("/app/access/users?tab=roles");
  const row = page
    .getByRole("table", { name: "역할 목록", exact: true })
    .getByRole("row")
    .filter({ hasText: "custom_reviewer" });
  await row.getByRole("button", { name: "수정", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "역할 수정", exact: true });
  await dialog.getByRole("textbox", { name: "설명", exact: true }).fill("보존할 초안");
  gateway.describeRole("custom_reviewer", "다른 관리자의 변경");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(
    dialog.getByText("역할이 변경되었거나 없어졌습니다. 편집창을 다시 열어 확인하세요."),
  ).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "설명", exact: true })).toHaveValue("보존할 초안");
  expect(gateway.writes).toHaveLength(0);
  expect(gateway.unexpected).toEqual([]);
});

test("역할 삭제도 확인 이후의 변경을 다시 조회해 전송하지 않는다", async ({ page }) => {
  const gateway = await installGateway(page);
  await page.goto("/app/access/users?tab=roles");
  const row = page
    .getByRole("table", { name: "역할 목록", exact: true })
    .getByRole("row")
    .filter({ hasText: "custom_reviewer" });
  await row.getByRole("button", { name: "삭제", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "역할 삭제", exact: true });
  gateway.describeRole("custom_reviewer", "확인 이후의 변경");
  await dialog.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(
    dialog.getByText("역할이 변경되었거나 없어졌습니다. 편집창을 다시 열어 확인하세요."),
  ).toBeVisible();
  expect(gateway.writes).toHaveLength(0);
  expect(gateway.unexpected).toEqual([]);
});

test("역할 저장 전송 후 읽기 전용 전환은 늦은 완료 알림·닫기·중복 저장을 막는다", async ({ page }) => {
  const gateway = await installGateway(page);
  gateway.holdWrite(200);
  await page.goto("/app/access/users?tab=roles");
  await page.getByRole("button", { name: "역할 추가", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "역할 추가", exact: true });
  await dialog.getByRole("textbox", { name: "역할 이름", exact: true }).fill("delayed_role");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(() => gateway.writes.length).toBe(1);
  gateway.revokeWrite("readonly");
  const refreshed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/admin/ui-bootstrap",
  );
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await refreshed).finished();
  await expect(dialog.getByText(/이 화면은 읽기 전용/)).toBeVisible();
  const finished = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/admin/roles",
  );
  gateway.releaseWrite();
  await (await finished).finished();
  await expect(dialog.getByRole("textbox", { name: "역할 이름", exact: true })).toBeEnabled();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  expect(gateway.writes).toHaveLength(1);
  expect(gateway.unexpected).toEqual([]);
});
