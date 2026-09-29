import { expect, test as base, type Locator, type Page, type Request } from "@playwright/test";

import type { EffectiveSetting } from "../../src/shared/api/domains/system.schemas";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// UI-only contract fixtures; these tests do not replace live gateway/CAS integration tests.
const featureKey = "ui.app.feature.system.settings";
const runtimeKey = "clickhouse.batch_size";
const secretKey = "clickhouse.password";
const globalKey = "ui.app.legacy_fallback";
const editorName = "시스템 설정 전환 설정";
const editButtonName = `${editorName} 편집`;
const guardTitle = "저장하지 않은 변경사항이 있습니다";
const syntheticSecret = "public-synthetic-replacement";
const openedAt = "2026-09-29T01:00:00Z";
const historyId = (key: string) => `public-history-${key}`;
type WriteOutcome = "saved" | "reload_pending" | "failed";

const bootstrap: UiBootstrapResponse = {
  backend_version: "v0.86.5",
  ui_version: "settings-unsaved-fixture",
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
    id: "settings-fixture",
    email: "settings@example.invalid",
    name: "설정 운영자",
    role: "admin",
    roles: ["admin"],
    team_id: "fixture",
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
      minimum_api_version: "v0.86.5",
      available: true,
    },
  ],
  system_status: { status: "healthy" },
  legacy_route_map: { "/app/system/settings": "/admin#/settings" },
};

function setting(
  key: string,
  value: string,
  version: number,
  type = "string",
  secret = false,
): EffectiveSetting {
  return {
    key,
    value,
    version,
    updated_at: openedAt,
    type,
    category: key.startsWith("ui.app.feature.")
      ? "ui.app.features"
      : key.startsWith("ui.")
        ? "ui.app"
        : "clickhouse",
    description: `${key} 공개 테스트 설정`,
    source: "admin",
    can_write: true,
    read_only: false,
    restart_required: false,
    is_secret: secret,
    is_set: true,
  };
}

async function installSettings(page: Page) {
  let settings = [
    setting(`${featureKey}.status`, "legacy", 3),
    setting(`${featureKey}.roles`, "admin", 2, "csv"),
    setting(`${featureKey}.rollout`, "0", 8, "int"),
    setting(`${featureKey}.readonly`, "true", 2, "bool"),
    setting(globalKey, "true", 6, "bool"),
    setting(runtimeKey, "1000", 3, "int"),
    setting(secretKey, "public-server-sentinel", 4, "string", true),
  ];
  const histories = new Map(
    settings
      .filter((row) => !row.is_secret)
      .map((row) => [
        row.key,
        {
          id: historyId(row.key),
          history_count: 1,
          key: row.key,
          old_value_json: JSON.stringify(row.type === "bool" ? "false" : "500"),
          new_value_json: JSON.stringify(row.value),
          is_secret: false,
          changed_by: "settings-fixture",
          reason: "public previous change",
          changed_at: openedAt,
        },
      ]),
  );
  const writes: Request[] = [];
  const unexpected: string[] = [];
  let reads = 0;
  let upToDate = true;
  let canWrite = true;
  let gate: Promise<void> | undefined;
  let release: (() => void) | undefined;
  let fail = false;
  const outcomes: WriteOutcome[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const call = `${request.method()} ${url.pathname}`;
    const json = (body: unknown, status = 200, requestId = "req-settings-fixture") =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "X-Request-ID": requestId },
        body: JSON.stringify(body),
      });
    if (call === "GET /admin/ui-bootstrap")
      return json(
        canWrite
          ? bootstrap
          : {
              ...bootstrap,
              permissions: ["admin:read"],
              user: { ...bootstrap.user, scopes: ["admin:read"] },
            },
      );
    if (call === "GET /health") return json({ status: "ok" });
    if (call === "GET /ready") return json({ status: "ready" });
    if (call === "GET /admin/ui-telemetry/summary")
      return json({
        enabled: false,
        days: 7,
        from: "2026-09-22T00:00:00Z",
        to: "2026-09-29T00:00:00Z",
        retention_days: 30,
        visit_limit: 100000,
        features: [],
      });
    if (call === "GET /admin/settings/effective") {
      reads += 1;
      return json({ settings, this_pod: { up_to_date: upToDate } });
    }
    if (call === "GET /admin/settings/history") {
      const key = url.searchParams.get("key") ?? "";
      expect(settings.some((row) => row.key === key)).toBe(true);
      expect(url.searchParams.get("limit")).toBe("20");
      const row = histories.get(key);
      return json({
        history: row
          ? Array.from({ length: Math.min(20, row.history_count) }, (_, index) =>
              index === 0
                ? row
                : { ...row, id: `${row.id}-older-${index}`, changed_at: "2026-09-29T00:00:00Z" },
            )
          : [],
      });
    }
    if (
      (request.method() === "DELETE" && url.pathname.startsWith("/admin/settings/by-key/")) ||
      call === "POST /admin/settings/rollback"
    ) {
      expect(request.headers()["x-vibe-ui"]).toBe("app");
      expect(request.headers()["x-vibe-route"]).toBe("system.settings");
      writes.push(request);
      if (!canWrite) {
        unexpected.push(`forbidden ${call}`);
        return json({ error: { message: "fixture requires admin:write" } }, 403);
      }
      const rollback = request.method() === "POST";
      const body = rollback
        ? (request.postDataJSON() as {
            key: string;
            reason: string;
            expected_version: number;
            expected_updated_at: string;
            expected_history_id: string;
            expected_history_count: number;
          })
        : {
            key: decodeURIComponent(url.pathname.split("/").at(-1) ?? ""),
            reason: url.searchParams.get("reason") ?? "",
            expected_version: Number(url.searchParams.get("expected_version")),
            expected_updated_at: undefined,
            expected_history_id: undefined,
            expected_history_count: undefined,
          };
      expect([globalKey, runtimeKey]).toContain(body.key);
      expect(body.reason.trim()).not.toBe("");
      expect(Number.isSafeInteger(body.expected_version)).toBe(true);
      if (rollback) {
        expect(typeof body.expected_updated_at).toBe("string");
        expect(typeof body.expected_history_id).toBe("string");
        expect(Number.isSafeInteger(body.expected_history_count)).toBe(true);
      }
      if (gate) await gate;
      const current = settings.find((row) => row.key === body.key);
      if (
        (current?.version ?? 0) !== body.expected_version ||
        (rollback &&
          ((current?.updated_at ?? "") !== body.expected_updated_at ||
            histories.get(body.key)?.id !== body.expected_history_id ||
            histories.get(body.key)?.history_count !== body.expected_history_count))
      )
        return json({ error: { message: "fixture CAS conflict", code: "setting_conflict" } }, 409);
      const outcome = outcomes.shift() ?? "saved";
      if (outcome === "failed")
        return json({ error: { message: "fixture recovery unavailable", code: "fixture_unavailable" } }, 503);
      // Explicit fixture history/env value: recovery does not save the discarded input.
      const recoveredAt = "2026-09-29T03:00:00Z";
      const previous = histories.get(body.key);
      const recoveredValue = rollback
        ? (JSON.parse(previous?.old_value_json ?? '""') as string)
        : body.key === globalKey
          ? "false"
          : "500";
      settings = settings.map((row) =>
        row.key === body.key
          ? {
              ...row,
              value: recoveredValue,
              source: rollback ? "admin" : "env",
              version: rollback ? (row.version ?? 0) + 1 : undefined,
              updated_at: rollback ? recoveredAt : undefined,
            }
          : row,
      );
      if (previous)
        histories.set(body.key, {
          ...previous,
          id: `${previous.id}-recovered`,
          history_count: previous.history_count + 1,
          old_value_json: JSON.stringify(current?.value ?? ""),
          new_value_json: rollback ? JSON.stringify(recoveredValue) : "",
          reason: body.reason,
          changed_at: recoveredAt,
        });
      upToDate = outcome !== "reload_pending";
      if (outcome === "reload_pending")
        return json(
          { error: { message: "fixture persisted, runtime reload pending", code: "setting_reload_pending" } },
          503,
          "req-settings-reload-pending",
        );
      return json(settings.find((row) => row.key === body.key));
    }
    if (
      request.method() === "PUT" &&
      (url.pathname === "/admin/settings/bulk" || url.pathname.startsWith("/admin/settings/by-key/"))
    ) {
      expect(request.headers()["x-vibe-ui"]).toBe("app");
      expect(request.headers()["x-vibe-route"]).toBe("system.settings");
      writes.push(request);
      if (!canWrite) {
        unexpected.push(`forbidden ${call}`);
        return json({ error: { message: "fixture requires admin:write" } }, 403);
      }
      const body = request.postDataJSON() as {
        value: string;
        expected_version: number;
        reason?: string;
        settings?: { key: string; value: string; expected_version: number }[];
      };
      const changes = body.settings ?? [
        {
          key: decodeURIComponent(url.pathname.split("/").at(-1) ?? ""),
          value: body.value,
          expected_version: body.expected_version,
        },
      ];
      expect(changes.length).toBeGreaterThan(0);
      for (const change of changes) expect(settings.some((row) => row.key === change.key)).toBe(true);
      if (gate) await gate;
      if (fail)
        return json(
          {
            error: { message: "fixture save unavailable", type: "server_error", code: "fixture_unavailable" },
          },
          503,
        );
      if (
        changes.some(
          (change) => settings.find((row) => row.key === change.key)?.version !== change.expected_version,
        )
      )
        return json(
          { error: { message: "fixture CAS conflict", type: "conflict", code: "setting_conflict" } },
          409,
        );
      const outcome = outcomes.shift() ?? "saved";
      if (outcome === "failed")
        return json({ error: { message: "fixture save unavailable", code: "fixture_unavailable" } }, 503);
      const savedAt = "2026-09-29T02:30:00Z";
      settings = settings.map((row) => {
        const change = changes.find((item) => item.key === row.key);
        const previous = histories.get(row.key);
        if (change && previous)
          histories.set(row.key, {
            ...previous,
            id: `${previous.id}-saved`,
            history_count: previous.history_count + 1,
            old_value_json: row.source === "admin" ? JSON.stringify(row.value) : "",
            new_value_json: JSON.stringify(change.value),
            reason: body.reason ?? "",
            changed_at: savedAt,
          });
        return change
          ? {
              ...row,
              value: row.is_secret ? "public-server-sentinel" : change.value,
              version: (row.version ?? 0) + 1,
              updated_at: savedAt,
            }
          : row;
      });
      upToDate = outcome !== "reload_pending";
      if (outcome === "reload_pending")
        return json(
          { error: { message: "fixture persisted, runtime reload pending", code: "setting_reload_pending" } },
          503,
          "req-settings-reload-pending",
        );
      return json(
        body.settings
          ? { ok: true, applied: changes.length }
          : settings.find((row) => row.key === changes[0]?.key),
      );
    }
    if (url.pathname.startsWith("/admin/") || url.pathname.startsWith("/auth/")) {
      unexpected.push(call);
      return json({ error: { message: "unexpected fixture API" } }, 501);
    }
    return route.continue();
  });
  return {
    writes,
    unexpected,
    readOnly: () => {
      canWrite = false;
    },
    readCount: () => reads,
    reloadApplied: () => {
      upToDate = true;
    },
    hold: () => {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => release?.(),
    fail: () => {
      fail = true;
    },
    queueOutcomes: (...next: WriteOutcome[]) => {
      outcomes.push(...next);
    },
    firstOverride: (key: string) => {
      const previous = histories.get(key);
      if (previous) histories.set(key, { ...previous, old_value_json: "", history_count: 1 });
      settings = settings.map((row) => (row.key === key ? { ...row, version: 1 } : row));
    },
    advance: (key: string, value: string, version: number) => {
      const changedAt = "2026-09-29T02:00:00Z";
      settings = settings.map((row) =>
        row.key === key ? { ...row, value, version, updated_at: changedAt } : row,
      );
      const row = histories.get(key);
      if (row)
        histories.set(key, {
          ...row,
          id: `${row.id}-${version}`,
          history_count: row.history_count + 1,
          old_value_json: row.new_value_json,
          new_value_json: JSON.stringify(value),
          changed_at: changedAt,
        });
    },
    environment: (key: string) => {
      settings = settings.map((row) =>
        row.key === key ? { ...row, source: "env", version: undefined, updated_at: undefined } : row,
      );
      const row = histories.get(key);
      if (row) histories.set(key, { ...row, new_value_json: "", history_count: row.history_count + 1 });
    },
    advanceHistory: (key: string, changed: "id" | "count") => {
      const row = histories.get(key);
      if (row)
        histories.set(
          key,
          changed === "id"
            ? { ...row, id: `${row.id}-concurrent` }
            : { ...row, history_count: row.history_count + 1 },
        );
    },
  };
}

type SettingsFixture = Awaited<ReturnType<typeof installSettings>>;
const test = base.extend<{ api: SettingsFixture }>({
  api: async ({ page }, run) => {
    const api = await installSettings(page);
    try {
      await run(api);
    } finally {
      api.release();
      expect(api.unexpected).toEqual([]);
    }
  },
});
const guard = (page: Page) => page.getByRole("alertdialog", { name: guardTitle });
async function openConsole(page: Page) {
  await page.goto("system/settings?tab=console");
  const trigger = page.getByRole("button", { name: editButtonName });
  await trigger.focus();
  await trigger.press("Enter");
  const dialog = page.getByRole("dialog", { name: editorName, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function openSheet(page: Page, key = runtimeKey, navigate = true) {
  if (navigate) await page.goto("system/settings?tab=runtime");
  const trigger = page.getByRole("button", { name: `${key} 설정 열기`, exact: true });
  await trigger.focus();
  await trigger.press("Enter");
  const sheet = page.getByRole("dialog", { name: key, exact: true });
  await expect(sheet).toBeVisible();
  return sheet;
}
async function discard(page: Page, editor: Locator) {
  await page.keyboard.press("Escape");
  await expect(guard(page)).toBeVisible();
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  await expect(editor).toBeHidden();
}
async function openGlobalRollback(page: Page) {
  await page.getByRole("button", { name: "기존 화면 이동 편집", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: globalKey, exact: true });
  await sheet.getByRole("button", { name: "이전 값으로 롤백", exact: true }).click();
  return page.getByRole("dialog", { name: "이전 값으로 롤백", exact: true });
}

test("전환 설정의 사유만 바꿔도 Escape는 초안과 입력 포커스를 보호한다", async ({ page, api }) => {
  const dialog = await openConsole(page);
  await dialog.getByLabel("변경 사유").fill("public reason draft");
  await page.keyboard.press("Escape");
  await expect(guard(page)).toBeVisible();
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  await expect(dialog.getByLabel("변경 사유")).toHaveValue("public reason draft");
  await expect(dialog.getByLabel("변경 사유")).toBeFocused();
  await discard(page, dialog);
  const trigger = page.getByRole("button", { name: editButtonName });
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await expect(dialog.getByLabel("변경 사유")).toHaveValue("");
  await dialog.getByLabel("변경 사유").fill("public reverted reason");
  await dialog.getByLabel("변경 사유").fill("");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(guard(page)).toBeHidden();
  expect(api.writes).toHaveLength(0);
});

test("설정 초안은 실제 뒤로가기와 native 새로고침을 막고 폐기한 뒤 이동한다", async ({ page, api }) => {
  await page.goto("system/settings?tab=runtime");
  await page
    .getByRole("complementary", { name: "주 메뉴" })
    .getByRole("link", { name: /시스템 설정/u })
    .click();
  await page.getByRole("tab", { name: "콘솔 전환", exact: true }).click();
  await page.getByRole("button", { name: editButtonName }).click();
  const dialog = page.getByRole("dialog", { name: editorName, exact: true });
  await dialog.getByLabel("변경 사유").fill("public navigation draft");
  await page.goBack();
  await expect(guard(page)).toBeVisible();
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  await expect(dialog.getByLabel("변경 사유")).toHaveValue("public navigation draft");
  const beforeUnload = page.waitForEvent("dialog");
  await page.evaluate(() => {
    setTimeout(() => window.location.reload(), 0);
  });
  const native = await beforeUnload;
  expect(native.type()).toBe("beforeunload");
  await native.dismiss();
  await expect(dialog.getByLabel("변경 사유")).toHaveValue("public navigation draft");
  await page.goBack();
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  await expect(page.getByRole("tab", { name: "런타임 설정", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(dialog).toBeHidden();
  await expect(page.locator("#main-content")).toBeFocused();
  expect(api.writes).toHaveLength(0);
});

for (const action of ["기본값(환경변수)으로 되돌리기", "이전 값으로 롤백"] as const) {
  test(`런타임 사유 초안은 ${action} 전 폐기 확인을 거치며 취소는 쓰지 않는다`, async ({ page, api }) => {
    const sheet = await openSheet(page);
    await sheet.getByLabel("변경 사유").fill("public reason only");
    await sheet.getByRole("button", { name: action, exact: true }).click();
    await expect(guard(page)).toBeVisible();
    await guard(page).getByRole("button", { name: "계속 편집" }).click();
    await expect(sheet.getByLabel("변경 사유")).toHaveValue("public reason only");
    expect(api.writes).toHaveLength(0);
    await sheet.getByRole("button", { name: action, exact: true }).click();
    await guard(page).getByRole("button", { name: "변경 버리기" }).click();
    await expect(sheet).toBeHidden();
    const confirmation = page.getByRole("dialog", {
      name: action === "이전 값으로 롤백" ? "이전 값으로 롤백" : "환경변수 기본값으로 되돌리기",
      exact: true,
    });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "취소", exact: true }).click();
    await expect(confirmation).toBeHidden();
    expect(api.writes).toHaveLength(0);
  });
}

for (const kind of ["revert", "rollback"] as const) {
  test(`콘솔 전역 ${kind}는 초안 폐기 후 사유와 기존 버전으로 한 번만 복구한다`, async ({ page, api }) => {
    await page.goto("system/settings?tab=console");
    await page.getByRole("button", { name: "기존 화면 이동 편집", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: globalKey, exact: true });
    await sheet.getByLabel("새 값", { exact: true }).selectOption("false");
    await sheet
      .getByRole("button", {
        name: kind === "rollback" ? "이전 값으로 롤백" : "기본값(환경변수)으로 되돌리기",
        exact: true,
      })
      .click();
    await expect(guard(page)).toBeVisible();
    expect(api.writes).toHaveLength(0);
    await guard(page).getByRole("button", { name: "변경 버리기" }).click();
    await expect(sheet).toBeHidden();
    const recovery = page.getByRole("dialog", {
      name: kind === "rollback" ? "이전 값으로 롤백" : "환경변수 기본값으로 되돌리기",
      exact: true,
    });
    const confirm = recovery.getByRole("button", {
      name: kind === "rollback" ? "롤백" : "되돌리기",
      exact: true,
    });
    await expect(confirm).toBeDisabled();
    await recovery.getByLabel(/^변경 사유/u).fill(`public ${kind} reason`);
    await recovery.getByRole("button", { name: "취소", exact: true }).click();
    await expect(guard(page)).toBeVisible();
    await guard(page).getByRole("button", { name: "계속 편집" }).click();
    await expect(recovery.getByLabel(/^변경 사유/u)).toHaveValue(`public ${kind} reason`);
    expect(api.writes).toHaveLength(0);
    api.hold();
    await confirm.dblclick();
    await expect.poll(() => api.writes.length).toBe(1);
    await expect(recovery.getByLabel(/^변경 사유/u)).toBeDisabled();
    await expect(recovery.getByRole("button", { name: "취소", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(recovery).toBeVisible();
    await expect(guard(page)).toBeHidden();
    const request = api.writes[0];
    if (!request) throw new Error("Expected a recovery request");
    expect(request.method()).toBe(kind === "rollback" ? "POST" : "DELETE");
    if (kind === "rollback") {
      expect(new URL(request.url()).pathname).toBe("/admin/settings/rollback");
      expect(request.postDataJSON()).toEqual({
        key: globalKey,
        reason: "public rollback reason",
        expected_version: 6,
        expected_updated_at: openedAt,
        expected_history_id: historyId(globalKey),
        expected_history_count: 1,
      });
    } else {
      const url = new URL(request.url());
      expect(url.pathname).toBe(`/admin/settings/by-key/${globalKey}`);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        reason: "public revert reason",
        expected_version: "6",
      });
      expect(request.postData()).toBeNull();
    }
    api.release();
    await expect(recovery).toBeHidden();
    expect(api.writes).toHaveLength(1);
    await page.getByRole("button", { name: "기존 화면 이동 편집", exact: true }).click();
    await expect(sheet.getByLabel("새 값", { exact: true })).toHaveValue("false");
  });
}

test("환경변수 설정도 검토한 삭제 이력과 no-override 스냅샷으로 롤백한다", async ({ page, api }) => {
  api.environment(globalKey);
  await page.goto("system/settings?tab=console");
  const recovery = await openGlobalRollback(page);
  await recovery.getByLabel(/^변경 사유/u).fill("public environment rollback");
  await recovery.getByRole("button", { name: "롤백", exact: true }).click();
  await expect(recovery).toBeHidden();
  expect(api.writes).toHaveLength(1);
  expect(api.writes[0]?.postDataJSON()).toEqual({
    key: globalKey,
    reason: "public environment rollback",
    expected_version: 0,
    expected_updated_at: "",
    expected_history_id: historyId(globalKey),
    expected_history_count: 2,
  });
});

for (const changed of ["id", "count"] as const) {
  test(`롤백 이력 ${changed} 충돌은 사유를 보존하고 재요청을 잠근 뒤 새 이력을 다시 검토하게 한다`, async ({
    page,
    api,
  }) => {
    // UI-only simulation: count can change while a clock-skewed env snapshot and
    // timestamp-sorted first history ID remain identical. DB concurrency is tested separately.
    if (changed === "count") api.environment(globalKey);
    const snapshot = {
      expected_version: changed === "count" ? 0 : 6,
      expected_updated_at: changed === "count" ? "" : openedAt,
      expected_history_id: historyId(globalKey),
      expected_history_count: changed === "count" ? 2 : 1,
    };
    await page.goto("system/settings?tab=console");
    const recovery = await openGlobalRollback(page);
    await recovery.getByLabel(/^변경 사유/u).fill("public conflicted rollback");
    api.advanceHistory(globalKey, changed);
    await recovery.getByRole("button", { name: "롤백", exact: true }).click();
    await expect(recovery.getByRole("alert")).toContainText("req-settings-fixture");
    await expect(recovery.getByLabel(/^변경 사유/u)).toHaveValue("public conflicted rollback");
    await expect(recovery.getByRole("button", { name: "롤백", exact: true })).toBeDisabled();
    expect(api.writes).toHaveLength(1);
    expect(api.writes[0]?.postDataJSON()).toEqual({
      key: globalKey,
      reason: "public conflicted rollback",
      ...snapshot,
    });
    await page.keyboard.press("Escape");
    await guard(page).getByRole("button", { name: "계속 편집" }).click();
    await expect(recovery.getByLabel(/^변경 사유/u)).toHaveValue("public conflicted rollback");
    await discard(page, recovery);
    const latest = await openGlobalRollback(page);
    await expect(latest.getByLabel(/^변경 사유/u)).toHaveValue("");
    await latest.getByLabel(/^변경 사유/u).fill("public reviewed latest history");
    await latest.getByRole("button", { name: "롤백", exact: true }).click();
    await expect(latest).toBeHidden();
    expect(api.writes).toHaveLength(2);
    expect(api.writes[1]?.postDataJSON()).toEqual({
      key: globalKey,
      reason: "public reviewed latest history",
      ...snapshot,
      expected_history_id: changed === "id" ? `${historyId(globalKey)}-concurrent` : historyId(globalKey),
      expected_history_count: snapshot.expected_history_count + (changed === "count" ? 1 : 0),
    });
  });
}

test("전환 설정 저장 대기는 모든 초안을 잠그고 한 원본 CAS 요청만 보낸다", async ({ page, api }) => {
  const dialog = await openConsole(page);
  await dialog.getByLabel("전환 상태", { exact: true }).selectOption("preview");
  await dialog.getByLabel("변경 사유").fill("public single submission");
  api.hold();
  await dialog.getByRole("button", { name: "저장", exact: true }).dblclick();
  await expect.poll(() => api.writes.length).toBe(1);
  for (const label of ["전환 상태", "미리보기 대상 역할", "점진 배포 비율(%)", "읽기 전용 강제", "변경 사유"])
    await expect(dialog.getByLabel(label, { exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(guard(page)).toBeHidden();
  const expected = {
    settings: [{ key: `${featureKey}.status`, value: "preview", expected_version: 3 }],
    reason: "public single submission",
  };
  expect(api.writes[0]?.postDataJSON()).toEqual(expected);
  api.release();
  await expect(dialog).toBeHidden();
  expect(api.writes).toHaveLength(1);
  expect(api.writes[0]?.postDataJSON()).toEqual(expected);
});

test("런타임 저장 실패는 입력과 위험 액션을 잠갔다가 초안 그대로 다시 편집하게 한다", async ({
  page,
  api,
}) => {
  const sheet = await openSheet(page);
  api.hold();
  api.fail();
  await sheet.getByLabel("새 값", { exact: true }).fill("2000");
  await sheet.getByLabel("변경 사유").fill("public failed draft");
  await sheet.getByRole("button", { name: "저장", exact: true }).dblclick();
  await expect.poll(() => api.writes.length).toBe(1);
  await expect(sheet.getByLabel("새 값", { exact: true })).toBeDisabled();
  await expect(sheet.getByLabel("변경 사유")).toBeDisabled();
  await expect(sheet.getByRole("button", { name: "기본값(환경변수)으로 되돌리기" })).toBeDisabled();
  await expect(sheet.getByRole("button", { name: "이전 값으로 롤백" })).toBeDisabled();
  expect(api.writes[0]?.postDataJSON()).toEqual({
    value: "2000",
    reason: "public failed draft",
    expected_version: 3,
  });
  api.release();
  await expect(sheet.getByRole("alert")).toContainText("req-settings-fixture");
  await expect(sheet.getByLabel("새 값", { exact: true })).toBeEnabled();
  await sheet.getByLabel("새 값", { exact: true }).fill("2100");
  await page.keyboard.press("Escape");
  await expect(guard(page)).toBeVisible();
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  await expect(sheet.getByLabel("새 값", { exact: true })).toHaveValue("2100");
  expect(api.writes).toHaveLength(1);
});

test("실제 자동 갱신 후에도 열린 런타임 편집기는 이전 CAS 버전을 유지한다", async ({ page, api }) => {
  await page.clock.install();
  await page.goto("system/settings?tab=runtime");
  await page.getByRole("combobox", { name: "자동 새로고침 간격", exact: true }).selectOption("60");
  const sheet = await openSheet(page, runtimeKey, false);
  await sheet.getByLabel("새 값", { exact: true }).fill("2000");
  const before = api.readCount();
  api.advance(runtimeKey, "9000", 9);
  await page.clock.fastForward(60001);
  await expect.poll(api.readCount).toBeGreaterThan(before);
  await expect(sheet.getByLabel("새 값", { exact: true })).toHaveValue("2000");
  await sheet.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(() => api.writes.length).toBe(1);
  expect(api.writes[0]?.postDataJSON()).toEqual({ value: "2000", expected_version: 3 });
  await expect(sheet.getByRole("alert")).toContainText("req-settings-fixture");
  await expect(sheet.getByLabel("새 값", { exact: true })).toHaveValue("2000");
  await discard(page, sheet);
  const latest = await openSheet(page, runtimeKey, false);
  await expect(latest.getByLabel("새 값", { exact: true })).toHaveValue("9000");
  expect(api.writes).toHaveLength(1);
});

test("비밀 설정은 서버 값을 다시 보여주거나 초안을 저장소에 남기지 않는다", async ({ page, api }) => {
  const sheet = await openSheet(page, secretKey);
  const input = sheet.getByLabel("새 비밀값", { exact: true });
  await expect(input).toHaveValue("");
  await expect(input).toHaveAttribute("type", "password");
  await expect(page.getByText("public-server-sentinel", { exact: true })).toHaveCount(0);
  await input.fill(syntheticSecret);
  await discard(page, sheet);
  const reopened = await openSheet(page, secretKey, false);
  await expect(reopened.getByLabel("새 비밀값", { exact: true })).toHaveValue("");
  const storage = await page.evaluate(() =>
    [...Object.values(localStorage), ...Object.values(sessionStorage)].join("\n"),
  );
  expect(storage).not.toContain(syntheticSecret);
  expect(storage).not.toContain("public-server-sentinel");
  expect(page.url()).not.toContain(syntheticSecret);
  expect(api.writes).toHaveLength(0);
});

test("읽기 전용 운영자는 설정과 복구 액션을 실행할 수 없다", async ({ page, api }) => {
  api.readOnly();
  const sheet = await openSheet(page);
  await expect(sheet.getByLabel("새 값", { exact: true })).toBeDisabled();
  await expect(sheet.getByLabel("변경 사유")).toBeDisabled();
  await expect(sheet.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await expect(sheet.getByRole("button", { name: "기본값(환경변수)으로 되돌리기" })).toBeDisabled();
  await expect(sheet.getByRole("button", { name: "이전 값으로 롤백" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(guard(page)).toBeHidden();
  expect(api.writes).toHaveLength(0);
});

test("최초 오버라이드의 빈 이전 이력은 롤백을 막고 기본값 복구는 허용한다", async ({ page, api }) => {
  api.firstOverride(runtimeKey);
  const sheet = await openSheet(page);
  await expect(sheet.getByText("이 변경 이력에 이전 값이 없어 롤백할 수 없습니다.")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "이전 값으로 롤백", exact: true })).toBeDisabled();
  await expect(sheet.getByRole("button", { name: "저장", exact: true })).toBeEnabled();
  await sheet.getByRole("button", { name: "기본값(환경변수)으로 되돌리기", exact: true }).click();
  const recovery = page.getByRole("dialog", { name: "환경변수 기본값으로 되돌리기", exact: true });
  await expect(recovery).toBeVisible();
  await recovery.getByRole("button", { name: "취소", exact: true }).click();
  await expect(recovery).toBeHidden();
  expect(api.writes).toHaveLength(0);
});

for (const surface of ["runtime", "console"] as const) {
  for (const kind of ["revert", "rollback"] as const) {
    test(`${surface} 반영 지연 안내는 후속 ${kind} 실패 동안 유지되고 성공 후 사라진다`, async ({
      page,
      api,
    }) => {
      const key = surface === "console" ? globalKey : runtimeKey;
      const open = async () => {
        if (surface === "runtime") return openSheet(page, key, false);
        await page.getByRole("button", { name: "기존 화면 이동 편집", exact: true }).click();
        const sheet = page.getByRole("dialog", { name: key, exact: true });
        await expect(sheet).toBeVisible();
        return sheet;
      };
      const recoveryDialog = (action: "revert" | "rollback") =>
        page.getByRole("dialog", {
          name: action === "rollback" ? "이전 값으로 롤백" : "환경변수 기본값으로 되돌리기",
          exact: true,
        });
      await page.goto(`system/settings?tab=${surface}`);
      const first = await open();
      api.queueOutcomes("reload_pending");
      if (kind === "rollback") {
        // DELETE persisted despite 503: the next opening must review an env
        // snapshot plus its deletion history, not repeat the deleted override.
        await first.getByRole("button", { name: "기본값(환경변수)으로 되돌리기", exact: true }).click();
        const initialRecovery = recoveryDialog("revert");
        await initialRecovery.getByLabel(/^변경 사유/u).fill("public persisted delete");
        await initialRecovery.getByRole("button", { name: "되돌리기", exact: true }).click();
        await expect(initialRecovery).toBeHidden();
        expect(api.writes[0]?.method()).toBe("DELETE");
      } else {
        const input = first.getByLabel("새 값", { exact: true });
        if (surface === "console") await input.selectOption("false");
        else await input.fill("2000");
        await first.getByLabel("변경 사유").fill("public persisted update");
        await first.getByRole("button", { name: "저장", exact: true }).click();
        await expect(first).toBeHidden();
        expect(api.writes[0]?.method()).toBe("PUT");
      }
      const pendingNotice = page.getByText("설정은 저장됐으며 런타임 반영을 기다리고 있습니다.", {
        exact: true,
      });
      await expect(pendingNotice).toBeVisible();
      await expect(page.getByText("요청 ID: req-settings-reload-pending")).toBeVisible();
      expect(api.writes).toHaveLength(1);
      const next = await open();
      await expect(next.getByLabel("새 값", { exact: true })).toHaveValue(
        surface === "console" ? "false" : kind === "rollback" ? "500" : "2000",
      );
      await next
        .getByRole("button", {
          name: kind === "rollback" ? "이전 값으로 롤백" : "기본값(환경변수)으로 되돌리기",
          exact: true,
        })
        .click();
      const recovery = recoveryDialog(kind);
      const reason = `public subsequent ${kind}`;
      await recovery.getByLabel(/^변경 사유/u).fill(reason);
      api.queueOutcomes("failed", "saved");
      const confirm = recovery.getByRole("button", {
        name: kind === "rollback" ? "롤백" : "되돌리기",
        exact: true,
      });
      await confirm.click();
      await expect(recovery.getByRole("alert")).toContainText("req-settings-fixture");
      await expect(recovery.getByLabel(/^변경 사유/u)).toHaveValue(reason);
      await expect(confirm).toBeEnabled();
      await expect(pendingNotice).toBeVisible();
      await expect(page.getByText("요청 ID: req-settings-reload-pending")).toBeVisible();
      expect(api.writes).toHaveLength(2);
      if (kind === "rollback") {
        expect(api.writes[1]?.postDataJSON()).toEqual({
          key,
          reason,
          expected_version: 0,
          expected_updated_at: "",
          expected_history_id: `${historyId(key)}-recovered`,
          expected_history_count: 2,
        });
      } else {
        const request = api.writes[1];
        if (!request) throw new Error("Expected a revert request");
        expect(request.method()).toBe("DELETE");
        expect(Object.fromEntries(new URL(request.url()).searchParams)).toEqual({
          reason,
          expected_version: surface === "console" ? "7" : "4",
        });
      }
      await confirm.click();
      await expect(recovery).toBeHidden();
      await expect(pendingNotice).toBeHidden();
      await expect(page.getByText("요청 ID: req-settings-reload-pending")).toBeHidden();
      expect(api.writes).toHaveLength(3);
      expect(api.writes[2]?.url()).toBe(api.writes[1]?.url());
      expect(api.writes[2]?.postData()).toBe(api.writes[1]?.postData());
    });
  }
}

for (const surface of ["runtime", "console"] as const) {
  test(`${surface} 단건 저장의 반영 지연은 같은 탭의 최신 적용 완료 조회 후 사라지고 재저장하지 않는다`, async ({
    page,
    api,
  }) => {
    const key = surface === "console" ? globalKey : runtimeKey;
    await page.goto(`system/settings?tab=${surface}`);
    const sheet =
      surface === "runtime"
        ? await openSheet(page, key, false)
        : await (async () => {
            await page.getByRole("button", { name: "기존 화면 이동 편집", exact: true }).click();
            return page.getByRole("dialog", { name: key, exact: true });
          })();
    const input = sheet.getByLabel("새 값", { exact: true });
    if (surface === "console") await input.selectOption("false");
    else await input.fill("2000");
    await sheet.getByLabel("변경 사유").fill("public same-tab persisted update");
    api.queueOutcomes("reload_pending");
    await sheet.getByRole("button", { name: "저장", exact: true }).click();
    await expect(sheet).toBeHidden();
    const pendingNotice = page.getByText("설정은 저장됐으며 런타임 반영을 기다리고 있습니다.", {
      exact: true,
    });
    await expect(pendingNotice).toBeVisible();
    await expect(page.getByText("요청 ID: req-settings-reload-pending")).toBeVisible();
    expect(api.writes).toHaveLength(1);
    const request = api.writes[0];
    if (!request) throw new Error("Expected one persisted setting update");
    expect(request.method()).toBe("PUT");
    expect(new URL(request.url()).pathname).toBe(`/admin/settings/by-key/${key}`);
    expect(request.postDataJSON()).toEqual({
      value: surface === "console" ? "false" : "2000",
      reason: "public same-tab persisted update",
      expected_version: surface === "console" ? 6 : 3,
    });
    api.reloadApplied();
    const previousReads = api.readCount();
    await page.locator(".page-header").getByRole("button", { name: "새로고침", exact: true }).click();
    await expect.poll(api.readCount).toBeGreaterThan(previousReads);
    await expect(pendingNotice).toBeHidden();
    await expect(page.getByText("요청 ID: req-settings-reload-pending")).toBeHidden();
    await expect(
      page.getByRole("tab", {
        name: surface === "console" ? "콘솔 전환" : "런타임 설정",
        exact: true,
      }),
    ).toHaveAttribute("aria-selected", "true");
    expect(api.writes).toHaveLength(1);
  });
}

test("저장된 콘솔 설정의 반영 지연은 탭 왕복 뒤에도 남고 서버 적용 확인 후에만 사라진다", async ({
  page,
  api,
}) => {
  const dialog = await openConsole(page);
  api.queueOutcomes("reload_pending");
  await dialog.getByLabel("전환 상태", { exact: true }).selectOption("preview");
  await dialog.getByLabel("변경 사유").fill("public persisted console rollout");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  const pendingNotice = page.getByText("설정은 저장됐으며 런타임 반영을 기다리고 있습니다.", {
    exact: true,
  });
  await expect(pendingNotice).toBeVisible();
  expect(api.writes).toHaveLength(1);
  expect(api.writes[0]?.postDataJSON()).toEqual({
    settings: [{ key: `${featureKey}.status`, value: "preview", expected_version: 3 }],
    reason: "public persisted console rollout",
  });
  await page.getByRole("tab", { name: "런타임 설정", exact: true }).click();
  // The default tab intentionally removes its query parameter.
  await expect(page.getByRole("tab", { name: "런타임 설정", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("tab", { name: "콘솔 전환", exact: true }).click();
  await expect(page).toHaveURL(/tab=console/u);
  await expect(pendingNotice).toBeVisible();
  await expect(guard(page)).toBeHidden();
  expect(api.writes).toHaveLength(1);
  api.reloadApplied();
  const previousReads = api.readCount();
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect.poll(api.readCount).toBeGreaterThan(previousReads);
  await expect(pendingNotice).toBeHidden();
  expect(api.writes).toHaveLength(1);
});

test("390px 다크 설정 폐기 확인은 axe 위반과 가로 넘침 없이 키보드로 돌아온다", async ({
  page,
  api,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  const dialog = await openConsole(page);
  await dialog.getByLabel("변경 사유").fill("public mobile reason");
  await page.keyboard.press("Escape");
  const alert = guard(page);
  await expect(alert).toBeVisible();
  await expect(alert.getByRole("button", { name: "계속 편집" })).toBeFocused();
  await expect(alert.getByRole("button", { name: "변경 버리기" })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: { run: (root: Document) => Promise<{ violations: { id: string; impact: string | null }[] }> };
      }
    ).axe;
    return (await axe.run(document)).violations.map(({ id, impact }) => ({ id, impact }));
  });
  await page.screenshot({ path: testInfo.outputPath("settings-unsaved-mobile-dark.png"), fullPage: true });
  await page.screenshot({
    path: testInfo.outputPath("settings-unsaved-mobile-dark-viewport.png"),
    fullPage: false,
  });
  expect(violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(alert).toBeHidden();
  await expect(dialog.getByLabel("변경 사유")).toBeFocused();
  expect(api.writes).toHaveLength(0);
});
