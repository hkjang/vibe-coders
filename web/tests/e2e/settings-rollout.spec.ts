import { expect, test, type Locator, type Page, type Request } from "@playwright/test";

import type { EffectiveSetting } from "../../src/shared/api/domains/system.schemas";
import type {
  SettingsBatchRequest,
  UiBootstrapResponse,
  UiTelemetryFeatureCount,
} from "../../src/shared/api/generated";

const featureKey = "ui.app.feature.system.settings";
const editorName = "시스템 설정 전환 설정";
const editButtonName = `${editorName} 편집`;

const bootstrap: UiBootstrapResponse = {
  backend_version: "v0.86.2",
  ui_version: "e2e-v0.86.2",
  api_version: "v1",
  ui: {
    enabled: true,
    default_entry: "/app/system/settings",
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
    id: "rollout-e2e-admin",
    email: "rollout@example.invalid",
    name: "콘솔 운영자",
    role: "admin",
    roles: ["admin"],
    team_id: "platform",
    scopes: ["admin:read", "admin:write"],
    features: { "system.settings": true },
  },
  capabilities: { raw_prompt_view: false },
  roles: ["admin"],
  permissions: ["admin:read", "admin:write"],
  allowed_features: ["system.settings"],
  migration_registry: [
    {
      feature_id: "system.settings",
      title: "시스템 설정",
      app_path: "/app/system/settings",
      legacy_path: "/admin#/settings",
      status: "preview",
      risk_level: "critical",
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
  legacy_route_map: { "/app/system/settings": "/admin#/settings" },
};

function setting(field: string, value: string, type: string, version?: number): EffectiveSetting {
  return {
    key: `${featureKey}.${field}`,
    category: "ui.app.features",
    type,
    description: `시스템 설정의 ${field}`,
    is_secret: false,
    read_only: false,
    restart_required: false,
    source: version === undefined ? "env" : "admin",
    value,
    can_write: true,
    ...(version === undefined ? {} : { version }),
  };
}

async function mockSettingsGateway(
  page: Page,
  outcome: "saved" | "conflict" | "reload_pending",
  telemetryOptions: { enabled?: boolean; status?: number; features?: UiTelemetryFeatureCount[] } = {},
) {
  let settings: EffectiveSetting[] = [
    setting("status", "legacy", "string", 3),
    setting("roles", "super_admin,admin", "csv"),
    setting("rollout", "0", "int", 8),
    setting("readonly", "true", "bool", 2),
  ];
  const writes: Request[] = [];
  const telemetry: Request[] = [];
  const summaryReads: Request[] = [];
  const unexpected: string[] = [];
  let reads = 0;

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const call = `${request.method()} ${url.pathname}`;
    const json = (body: unknown, status = 200, requestId?: string): Promise<void> =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: requestId ? { "X-Request-ID": requestId } : {},
        body: JSON.stringify(body),
      });

    if (url.pathname.startsWith("/admin/") && request.method() !== "GET") writes.push(request);
    if (call === "GET /admin/ui-bootstrap")
      return json({
        ...bootstrap,
        ui: { ...bootstrap.ui, telemetry_enabled: telemetryOptions.enabled ?? false },
      });
    if (call === "POST /admin/ui-telemetry/events") {
      telemetry.push(request);
      return route.fulfill({ status: telemetryOptions.status ?? 204 });
    }
    if (call === "GET /admin/ui-telemetry/summary") {
      summaryReads.push(request);
      return json({
        enabled: telemetryOptions.enabled ?? false,
        days: Number(url.searchParams.get("days") ?? 7),
        from: "2026-09-22T00:00:00Z",
        to: "2026-09-29T00:00:00Z",
        retention_days: 30,
        visit_limit: 100_000,
        features: telemetryOptions.features ?? [],
      });
    }
    if (call === "GET /health") return json({ status: "ok" });
    if (call === "GET /ready") return json({ status: "ready" });
    if (call === "GET /admin/settings/effective") {
      reads += 1;
      return json({ settings });
    }
    if (call === "PUT /admin/settings/bulk") {
      const body = request.postDataJSON() as SettingsBatchRequest;
      if (outcome === "conflict") {
        settings = settings.map((row) =>
          row.key === `${featureKey}.status` ? { ...row, value: "stable", version: 4 } : row,
        );
      } else {
        settings = settings.map((row) => {
          const change = body.settings.find((item) => item.key === row.key);
          return change
            ? { ...row, value: change.value, version: (row.version ?? 0) + 1, source: "admin" }
            : row;
        });
      }
      if (outcome === "saved") return json({ ok: true, applied: body.settings.length });
      return json(
        {
          error: {
            message: "untrusted server detail",
            type: "server_error",
            code: outcome === "conflict" ? "setting_conflict" : "setting_reload_pending",
          },
        },
        outcome === "conflict" ? 409 : 503,
        `req-rollout-${outcome}`,
      );
    }
    if (url.pathname.startsWith("/admin/")) {
      unexpected.push(call);
      return json({ error: { message: `Unexpected admin call: ${call}` } }, 501);
    }
    if (url.pathname === "/admin")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="ko"><meta charset="utf-8"><title>기존 화면</title><h1>기존 관리자 화면</h1></html>',
      });
    if (request.resourceType() === "document" && url.pathname.startsWith("/app/")) {
      const response = await route.fetch();
      return route.fulfill({ response });
    }
    await route.continue();
  });
  return { writes, telemetry, summaryReads, unexpected, readCount: () => reads };
}

test("선택적 사용 관측은 필터를 보내지 않고 한 방문과 키보드 기존 화면 열기를 연결한다", async ({ page }) => {
  const api = await mockSettingsGateway(page, "saved", { enabled: true });
  await page.goto("system/settings?tab=console&q=private-filter");
  await expect(page.getByRole("heading", { name: "신규 콘솔 사용 관측" })).toBeVisible();
  await expect.poll(() => api.telemetry.length).toBe(1);
  const visit = api.telemetry[0];
  if (!visit) throw new Error("Expected one observed visit");
  expect(visit.postDataJSON()).toEqual({
    feature_id: "system.settings",
    event: "visit",
    visit_id: expect.stringMatching(/^[a-f0-9]{32}$/),
  });
  expect(visit.headers()["referer"]).toBeUndefined();
  expect(new URL(visit.url()).search).toBe("");
  await page.getByLabel("조회 기간", { exact: true }).selectOption("30");
  await expect(page).toHaveURL(/telemetry_days=30/);
  await expect(page.getByText(/수집 켜짐/)).toBeVisible();
  expect(api.summaryReads.length).toBeGreaterThan(0);
  for (const read of api.summaryReads) expect(read.headers()["referer"]).toBeUndefined();
  expect(api.telemetry).toHaveLength(1);
  const legacy = page.getByRole("link", { name: "기존 화면에서 열기", exact: true });
  await legacy.focus();
  await legacy.press("Enter");
  await expect(page).toHaveURL(/\/admin#\/settings$/);
  await expect.poll(() => api.telemetry.length).toBe(2);
  const legacyEvent = api.telemetry[1];
  if (!legacyEvent) throw new Error("Expected one observed Legacy opening");
  expect(legacyEvent.postDataJSON()).toEqual({ ...visit.postDataJSON(), event: "legacy_fallback" });
  expect(legacyEvent.headers()["referer"]).toBeUndefined();
  expect(api.unexpected).toEqual([]);
});

test("사용 관측의 401은 재로그인이나 기존 화면 이동을 막지 않는다", async ({ page }) => {
  const api = await mockSettingsGateway(page, "saved", { enabled: true, status: 401 });
  await page.goto("system/settings?tab=console");
  await expect(page.getByRole("heading", { name: "시스템 설정", exact: true })).toBeVisible();
  await expect.poll(() => api.telemetry.length).toBe(1);
  await page.getByRole("link", { name: "기존 화면에서 열기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "기존 관리자 화면" })).toBeVisible();
  await expect.poll(() => api.telemetry.length).toBe(2);
  expect(api.unexpected).toEqual([]);
});

test("기본 꺼짐에서는 사용 관측을 전송하지 않고 조회 기간을 새로고침 후 복원한다", async ({ page }) => {
  const api = await mockSettingsGateway(page, "saved");
  await page.goto("system/settings?tab=console&telemetry_days=30");
  await expect(page.getByLabel("조회 기간", { exact: true })).toHaveValue("30");
  await expect(page.getByText(/수집 꺼짐/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("조회 기간", { exact: true })).toHaveValue("30");
  await expect(page.getByText(/수집 꺼짐/)).toBeVisible();
  expect(api.telemetry).toEqual([]);
  expect(api.unexpected).toEqual([]);
});

test("좁은 화면에서도 한글 사용 관측과 조회 작업을 읽고 조작한다", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await mockSettingsGateway(page, "saved", {
    features: [{ feature_id: "system.settings", visits: 20, legacy_opens: 5 }],
  });
  await page.goto("system/settings?tab=console");
  const panel = page.locator("section").filter({
    has: page.getByRole("heading", { name: "신규 콘솔 사용 관측", exact: true }),
  });
  const table = panel.getByRole("table");
  await expect(table.getByRole("rowheader", { name: "시스템 설정" })).toBeVisible();
  await expect(table.getByRole("cell", { name: "25%", exact: true })).toBeVisible();
  const refresh = panel.getByRole("button", { name: "관측 결과 새로고침" });
  await refresh.focus();
  await refresh.press("Enter");
  await expect.poll(() => api.summaryReads.length).toBe(2);
  await expect(refresh).toBeFocused();
  await panel.getByLabel("조회 기간", { exact: true }).selectOption("30");
  await expect(page).toHaveURL(/telemetry_days=30/);
  const usageScroll = panel.getByRole("region", { name: "기능별 사용 관측" });
  await usageScroll.focus();
  await usageScroll.press("ArrowRight");
  await expect.poll(() => usageScroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  const settingsScroll = page.getByRole("region", { name: "기능별 전환 상태 표", exact: true });
  await settingsScroll.focus();
  await page.keyboard.press("Tab");
  const edit = settingsScroll.getByRole("button", { name: editButtonName });
  await expect(edit).toBeFocused();
  await expect.poll(() => settingsScroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await edit.press("Enter");
  await expect(page.getByRole("dialog", { name: editorName, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(edit).toBeFocused();
  await testInfo.attach("mobile-layout", {
    contentType: "application/json",
    body: JSON.stringify(
      await page.evaluate(() => ({
        width: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        overflow: Array.from(document.querySelectorAll("*"))
          .filter((element) => element.getBoundingClientRect().right > window.innerWidth)
          .map((element) => ({
            tag: element.tagName,
            class: element.className,
            width: element.getBoundingClientRect().width,
          })),
      })),
    ),
  });
  await panel.screenshot({ path: testInfo.outputPath("console-usage-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(api.telemetry).toEqual([]);
  expect(api.unexpected).toEqual([]);
});

async function openEditor(page: Page): Promise<Locator> {
  await page.goto("system/settings?tab=console");
  await expect(page).toHaveURL(/\/app\/system\/settings\?tab=console$/);
  await expect(page.getByRole("heading", { name: "시스템 설정", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "콘솔 전환", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const trigger = page.getByRole("button", { name: editButtonName });
  await trigger.focus();
  await trigger.press("Enter");
  const dialog = page.getByRole("dialog", { name: editorName, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

function expectSingleBulkWrite(page: Page, writes: Request[], body: SettingsBatchRequest): void {
  expect(writes.map((request) => `${request.method()} ${new URL(request.url()).pathname}`)).toEqual([
    "PUT /admin/settings/bulk",
  ]);
  const request = writes[0];
  if (!request) throw new Error("Expected one bulk settings request");
  expect(new URL(request.url()).origin).toBe(new URL(page.url()).origin);
  expect(request.headers()["x-vibe-route"]).toBe("system.settings");
  expect(request.postDataJSON()).toEqual(body);
}

test("콘솔 전환 직접 접근에서 한국어 편집과 키보드 포커스를 유지하며 여러 필드를 한 번에 저장한다", async ({
  page,
}) => {
  const api = await mockSettingsGateway(page, "saved");
  const dialog = await openEditor(page);
  const close = dialog.getByRole("button", { name: "대화상자 닫기" });
  const status = dialog.getByLabel("전환 상태", { exact: true });
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(status).toBeFocused();
  await expect(status.locator("option:checked")).toHaveText("기존 화면 (legacy)");
  await expect(dialog.getByLabel("읽기 전용 강제").locator("option:checked")).toHaveText("쓰기 차단 (true)");
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "저장", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const trigger = page.getByRole("button", { name: editButtonName });
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");

  await status.selectOption({ label: "미리보기 (preview)" });
  await dialog.getByLabel("미리보기 대상 역할").fill("viewer,developer");
  await dialog.getByLabel("점진 배포 비율(%)").fill("35");
  await dialog.getByLabel("읽기 전용 강제").selectOption({ label: "쓰기 허용 (false)" });
  await dialog.getByLabel("변경 사유").fill("  점진 배포 확대  ");
  await expect(dialog.getByText("현재 대상: 조회자, 개발자")).toBeVisible();
  expect(api.writes).toHaveLength(0);
  await dialog.getByRole("button", { name: "저장", exact: true }).press("Enter");

  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect.poll(api.readCount).toBe(2);
  expectSingleBulkWrite(page, api.writes, {
    settings: [
      { key: `${featureKey}.status`, value: "preview", expected_version: 3 },
      { key: `${featureKey}.roles`, value: "viewer,developer", expected_version: 0 },
      { key: `${featureKey}.rollout`, value: "35", expected_version: 8 },
      { key: `${featureKey}.readonly`, value: "false", expected_version: 2 },
    ],
    reason: "점진 배포 확대",
  });
  await expect(page.getByRole("table", { name: "기능별 콘솔 전환 상태" })).toContainText("35%");
  await page.reload();
  await expect(page.getByRole("tab", { name: "콘솔 전환", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("table", { name: "기능별 콘솔 전환 상태" })).toContainText("35%");
  expect(api.writes).toHaveLength(1);
  expect(api.unexpected).toEqual([]);
});

test("충돌 시 초안을 유지하고 저장을 막으며 다시 연 편집기에 최신 설정을 표시한다", async ({ page }) => {
  await page.clock.install();
  const api = await mockSettingsGateway(page, "conflict");
  const dialog = await openEditor(page);
  await dialog.getByLabel("전환 상태", { exact: true }).selectOption("preview");
  await dialog.getByLabel("변경 사유").fill("초안 유지");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();

  await expect(dialog.getByText(/다른 작업자가 전환 설정을 변경해 저장하지 않았습니다/)).toBeVisible();
  await expect(dialog.getByLabel("전환 상태", { exact: true })).toHaveValue("preview");
  await expect(dialog.getByLabel("변경 사유")).toHaveValue("초안 유지");
  await expect(dialog.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await expect(dialog.getByText("요청 ID: req-rollout-conflict")).toBeVisible();
  await expect.poll(api.readCount).toBe(2);
  await expect(page.getByText("untrusted server detail")).toHaveCount(0);
  await expect(page.getByText("콘솔 전환 설정을 저장했습니다. 화면을 새로고침하면 적용됩니다.")).toHaveCount(
    0,
  );
  await page.clock.fastForward(5_000);
  expectSingleBulkWrite(page, api.writes, {
    settings: [{ key: `${featureKey}.status`, value: "preview", expected_version: 3 }],
    reason: "초안 유지",
  });

  await page.keyboard.press("Escape");
  const trigger = page.getByRole("button", { name: editButtonName });
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await expect(dialog.getByLabel("전환 상태", { exact: true })).toHaveValue("stable");
  await expect(dialog.getByRole("button", { name: "저장", exact: true })).toBeEnabled();
  expect(api.writes).toHaveLength(1);
  expect(api.unexpected).toEqual([]);
});

test("저장 후 런타임 반영이 지연되면 안내하고 자동 재저장하지 않는다", async ({ page }) => {
  await page.clock.install();
  const api = await mockSettingsGateway(page, "reload_pending");
  const dialog = await openEditor(page);
  await dialog.getByLabel("전환 상태", { exact: true }).selectOption("preview");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: editButtonName })).toBeFocused();
  await expect(page.getByText("설정은 저장됐으며 런타임 반영을 기다리고 있습니다.")).toBeVisible();
  await expect(page.getByText("요청 ID: req-rollout-reload_pending")).toBeVisible();
  await expect(page.getByRole("table", { name: "기능별 콘솔 전환 상태" })).toContainText("preview");
  await expect.poll(api.readCount).toBe(2);
  await expect(page.getByText("untrusted server detail")).toHaveCount(0);
  await expect(page.getByText("콘솔 전환 설정을 저장했습니다. 화면을 새로고침하면 적용됩니다.")).toHaveCount(
    0,
  );
  await page.clock.fastForward(5_000);
  expectSingleBulkWrite(page, api.writes, {
    settings: [{ key: `${featureKey}.status`, value: "preview", expected_version: 3 }],
    reason: "",
  });
  expect(api.unexpected).toEqual([]);
});
