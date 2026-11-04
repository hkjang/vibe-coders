import { expect, test, type Page } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

async function install(page: Page) {
  const user = {
    id: "public-policy-admin",
    email: "policy@example.invalid",
    name: "정책 검증",
    role: "admin",
    roles: ["admin"],
    team_id: "",
    scopes: ["observability:read", "mcp:admin"],
  };
  const bootstrap: UiBootstrapResponse = {
    backend_version: "v0.86.61",
    ui_version: "policy-fixture",
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
  let policies = [
    {
      server_label: "public-server",
      mode: "block",
      note: "원래 메모",
      created_at: "2026-10-14T00:00:00Z",
      updated_at: "2026-10-14T00:00:00Z",
    },
  ];
  let allowlist = false;
  const state = { malformed: false, conflict: false, postStatus: 201, reads: 0 };
  const writes: { method: string; body?: unknown }[] = [];
  const unexpected: string[] = [];
  let held: Promise<void> | undefined;
  let release = () => {};
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/app/")) return route.continue();
    const json = (body: unknown) => route.fulfill({ json: body });
    if (url.pathname === "/auth/me") return json({ authenticated: true, user });
    if (url.pathname === "/admin/ui-bootstrap") return json(bootstrap);
    if (url.pathname === "/health") return json({ status: "ok" });
    if (url.pathname === "/admin/mcp/loops") return json({ loops: [], threshold: 10 });
    if (url.pathname === "/admin/mcp/policies") {
      if (request.method() === "GET") {
        state.reads++;
        if (state.reads > 1) await held;
        if (state.malformed) return json({ policies });
        return json({
          policies: state.conflict ? policies.map((p) => ({ ...p, note: "다른 변경" })) : policies,
          allowlist_enabled: allowlist,
        });
      }
      if (request.method() === "POST") {
        const body = request.postDataJSON() as {
          server_label?: string;
          mode?: string;
          note?: string;
          allowlist_enabled?: boolean;
        };
        writes.push({ method: "POST", body });
        if (state.postStatus >= 400)
          return route.fulfill({
            status: state.postStatus,
            headers: { "X-Request-ID": "public-policy-error" },
            json: { error: { code: "unavailable", type: "server_error", message: "public failure" } },
          });
        if (body.allowlist_enabled !== undefined) {
          allowlist = body.allowlist_enabled;
          return json({ allowlist_enabled: allowlist });
        }
        const policy = {
          server_label: body.server_label ?? "",
          mode: body.mode ?? "",
          note: body.note ?? "",
          created_at: "2026-10-14T00:00:00Z",
          updated_at: "2026-10-14T00:00:00Z",
        };
        policies = [...policies.filter((p) => p.server_label !== policy.server_label), policy];
        return route.fulfill({ status: 201, json: { policy } });
      }
    }
    if (url.pathname === "/admin/mcp/policies/public-server" && request.method() === "DELETE") {
      writes.push({ method: "DELETE" });
      policies = [];
      return json({ status: "deleted", server_label: "public-server" });
    }
    unexpected.push(request.method() + " " + url.pathname);
    return route.fulfill({ status: 500 });
  });
  return {
    state,
    writes,
    unexpected,
    readonly: () => {
      const feature = bootstrap.migration_registry?.[0];
      if (feature) feature.read_only = true;
    },
    hold: () => {
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => release(),
  };
}
async function edit(page: Page) {
  await page.goto("/app/mcp?tab=policy");
  await page.getByRole("button", { name: "public-server 정책 편집", exact: true }).click();
  return page.getByRole("dialog", { name: "MCP 서버 정책 편집", exact: true });
}
async function runtime(page: Page) {
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}

test("정책 편집의 비교와 삭제의 대상 문구를 검증한다", async ({ page }) => {
  const fixture = await install(page);
  const dialog = await edit(page);
  await expect(dialog.getByRole("button", { name: "검토한 정책 저장", exact: true })).toBeDisabled();
  await dialog.getByLabel("메모", { exact: true }).fill("");
  await expect(dialog.getByText("변경 후: 없음", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "검토한 정책 저장", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.writes).toEqual([
    { method: "POST", body: { server_label: "public-server", mode: "block", note: "" } },
  ]);
  await page.getByRole("button", { name: "public-server 정책 삭제", exact: true }).click();
  const remove = page.getByRole("dialog", { name: "정책을 삭제할까요?", exact: true });
  await expect(remove.getByText("삭제 후: 미등록 · 서버 기본 허용", { exact: true })).toBeVisible();
  await expect(remove.getByRole("button", { name: "삭제", exact: true })).toBeDisabled();
  await remove.getByLabel("확인 문구", { exact: false }).fill("public-server");
  await remove.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(remove).toHaveCount(0);
  expect(fixture.writes).toHaveLength(2);
  expect(fixture.unexpected).toEqual([]);
});
test("허용목록 모드는 확인 전 저장하지 않는다", async ({ page }) => {
  const fixture = await install(page);
  await page.goto("/app/mcp?tab=policy");
  await page.getByRole("button", { name: "허용목록 변경 검토", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "허용목록 모드를 변경할까요?", exact: true });
  expect(fixture.writes).toEqual([]);
  await dialog.getByLabel("확인 문구", { exact: false }).fill("허용목록 사용");
  await dialog.getByRole("button", { name: "검토한 모드 적용", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.writes).toEqual([{ method: "POST", body: { allowlist_enabled: true } }]);
  await expect(page.getByText("허용목록: 사용", { exact: true })).toBeVisible();
});
test("동시 정책 변경을 발견하면 초안을 보존하고 전송하지 않는다", async ({ page }) => {
  const fixture = await install(page);
  const dialog = await edit(page);
  await dialog.getByLabel("메모", { exact: true }).fill("내 초안");
  fixture.state.conflict = true;
  await dialog.getByRole("button", { name: "검토한 정책 저장", exact: true }).click();
  await expect(dialog.getByText("현재 설정을 다시 확인하세요.", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("메모", { exact: true })).toHaveValue("내 초안");
  expect(fixture.writes).toEqual([]);
});
test("사전 조회 중 읽기 전용 전환은 초안을 유지하고 저장을 막는다", async ({ page }) => {
  const fixture = await install(page);
  const dialog = await edit(page);
  await dialog.getByLabel("메모", { exact: true }).fill("내 초안");
  fixture.hold();
  await dialog.getByRole("button", { name: "검토한 정책 저장", exact: true }).click();
  await expect.poll(() => fixture.state.reads).toBe(2);
  fixture.readonly();
  await runtime(page);
  fixture.release();
  await expect(dialog.getByRole("button", { name: "검토한 정책 저장", exact: true })).toBeDisabled();
  await expect(dialog.getByLabel("메모", { exact: true })).toHaveValue("내 초안");
  expect(fixture.writes).toEqual([]);
});
test("허용목록 값이 누락되면 미사용으로 추정하지 않는다", async ({ page }) => {
  const fixture = await install(page);
  fixture.state.malformed = true;
  await page.goto("/app/mcp?tab=policy");
  await expect(page.getByText("MCP 정책 조회에 실패했습니다.", { exact: true })).toBeVisible();
  await expect(page.getByText("허용목록: 미사용", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "허용목록 변경 검토", exact: true })).toBeDisabled();
  expect(fixture.writes).toEqual([]);
});
test("저장 실패의 요청 ID를 표시하고 자동 재전송하지 않는다", async ({ page }) => {
  const fixture = await install(page);
  fixture.state.postStatus = 403;
  const dialog = await edit(page);
  await dialog.getByLabel("메모", { exact: true }).fill("내 초안");
  await dialog.getByRole("button", { name: "검토한 정책 저장", exact: true }).click();
  await expect(dialog.getByText("요청 ID: public-policy-error", { exact: false })).toBeVisible();
  expect(fixture.writes).toHaveLength(1);
});
test("모바일 어두운 정책 검토창의 긴 메모·키보드·저장 버튼을 검증한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  const fixture = await install(page);
  const dialog = await edit(page);
  await dialog.getByLabel("메모", { exact: true }).fill("공개검토메모".repeat(80));
  const save = dialog.getByRole("button", { name: "검토한 정책 저장", exact: true });
  await save.focus();
  await expect(save).toBeFocused();
  await expect(save).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await dialog.evaluate((node) => {
      const r = node.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
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
  await page.screenshot({ path: test.info().outputPath("mcp-policy-mobile.png"), fullPage: true });
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect(fixture.writes).toHaveLength(1);
});
