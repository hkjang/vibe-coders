import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SystemSettingsPage } from "@/features/system/settings/SystemSettingsPage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authState = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"] as readonly string[] }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authState.scopes }) };
});

const clickhouseUrl = {
  key: "clickhouse.url",
  category: "clickhouse",
  type: "string",
  description: "ClickHouse HTTP 주소",
  is_secret: false,
  is_set: true,
  read_only: false,
  restart_required: true,
  source: "admin",
  effective_source: "db_setting",
  value: "http://clickhouse:8123",
  permission_group: "ops",
  can_write: true,
  version: 3,
  updated_at: "2026-09-01T00:00:00Z",
  updated_by: "operator@example.com",
};

const clickhousePassword = {
  key: "clickhouse.password",
  category: "clickhouse",
  type: "string",
  description: "ClickHouse 접속 비밀번호",
  is_secret: true,
  is_set: true,
  read_only: false,
  restart_required: false,
  source: "admin",
  effective_source: "db_setting",
  value: "********",
  permission_group: "security",
  can_write: true,
};

const rawBodies = {
  key: "logging.raw_bodies",
  category: "logging",
  type: "bool",
  description: "요청·응답 원문 저장",
  is_secret: false,
  is_set: true,
  read_only: true,
  restart_required: false,
  source: "env",
  effective_source: "bootstrap_env",
  value: "false",
  permission_group: "security",
  can_write: false,
};

function consoleFeatureSetting(field: string, value: string, type = "string") {
  return {
    key: `ui.app.feature.system.settings.${field}`,
    category: "ui.app.features",
    type,
    description: `시스템 설정의 ${field}`,
    is_secret: false,
    is_set: true,
    read_only: false,
    restart_required: false,
    source: "env",
    effective_source: "bootstrap_env",
    value,
    permission_group: "admin",
    can_write: true,
  };
}

const effectiveSettings = {
  settings: [
    clickhouseUrl,
    clickhousePassword,
    rawBodies,
    {
      key: "ui.app.enabled",
      category: "ui.app",
      type: "bool",
      description: "신규 콘솔 활성화",
      is_secret: false,
      is_set: true,
      read_only: false,
      restart_required: false,
      source: "admin",
      effective_source: "db_setting",
      value: "true",
      permission_group: "admin",
      can_write: true,
      version: 1,
    },
    consoleFeatureSetting("status", "legacy"),
    consoleFeatureSetting("roles", "super_admin,admin", "csv"),
    consoleFeatureSetting("rollout", "0", "int"),
    consoleFeatureSetting("readonly", "true", "bool"),
  ],
  category: "",
  resolution_order: ["request_override", "runtime_flag", "db_setting", "bootstrap_env"],
  this_pod: {
    hostname: "gateway-0",
    last_reload_at: "2026-09-06T00:00:00Z",
    up_to_date: true,
    reload_interval: "30s",
  },
};

function renderPage(route = "/system/settings") {
  return renderScreen(<SystemSettingsPage />, { route, path: "/system/settings" });
}

afterEach(() => {
  vi.restoreAllMocks();
  authState.scopes = ["admin:read", "admin:write"];
});

describe("SystemSettingsPage — 런타임 설정", () => {
  beforeEach(() => {
    authState.scopes = ["admin:read", "admin:write"];
  });

  it("renders runtime settings, masks secrets and reports pod convergence", async () => {
    mockApi({ "GET /admin/settings/effective": () => effectiveSettings });
    renderPage();

    expect(await screen.findByText("clickhouse.url")).toBeVisible();
    expect(screen.getByText("http://clickhouse:8123")).toBeVisible();
    expect(screen.getByText("설정됨 (표시하지 않음)")).toBeVisible();
    expect(screen.queryByText("********")).not.toBeInTheDocument();
    expect(screen.getByText(/gateway-0/)).toBeVisible();
    // Console rollout keys belong to their own tab.
    expect(screen.queryByText("ui.app.enabled")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /기존 화면에서 열기/ })).toHaveAttribute(
      "href",
      "/admin#/settings",
    );
  });

  it("shows an empty state when the filter matches nothing", async () => {
    mockApi({ "GET /admin/settings/effective": () => ({ ...effectiveSettings, settings: [] }) });
    renderPage();

    expect(await screen.findByText("조건에 맞는 설정이 없습니다.")).toBeVisible();
  });

  it("keeps the request ID visible when the settings query fails", async () => {
    mockApi({
      "GET /admin/settings/effective": () => {
        throw apiFailure("설정을 불러오지 못했습니다.", 503, "req-settings-1");
      },
    });
    renderPage();

    expect(await screen.findByText("요청 ID: req-settings-1")).toBeVisible();
  });

  it("disables writes and explains the missing scope for a read-only operator", async () => {
    authState.scopes = ["admin:read"];
    mockApi({ "GET /admin/settings/effective": () => effectiveSettings });
    renderPage();

    expect(await screen.findByText("변경 권한이 없습니다.")).toBeVisible();
    expect(screen.getByRole("button", { name: "ClickHouse 연결 테스트" })).toBeDisabled();
    expect(screen.getByText("연결 테스트에는 admin:write 권한이 필요합니다.")).toBeVisible();
  });

  it("saves a setting value with the change reason and the expected version", async () => {
    const api = mockApi({
      "GET /admin/settings/effective": () => effectiveSettings,
      "GET /admin/settings/history": () => ({ history: [] }),
      "PUT /admin/settings/by-key/clickhouse.url": () => clickhouseUrl,
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "clickhouse.url 설정 열기" }));
    const valueInput = await screen.findByLabelText("새 값");
    await user.clear(valueInput);
    await user.type(valueInput, "http://clickhouse:9000");
    await user.type(screen.getByLabelText("변경 사유"), "노드 교체");
    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() =>
      expect(api.bodies("PUT /admin/settings/by-key/clickhouse.url")).toEqual([
        { value: "http://clickhouse:9000", reason: "노드 교체", expected_version: 3 },
      ]),
    );
  });

  it("offers no rollback for a secret and never seeds its editor with a value", async () => {
    mockApi({
      "GET /admin/settings/effective": () => effectiveSettings,
      "GET /admin/settings/history": () => ({ history: [] }),
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "clickhouse.password 설정 열기" }));
    expect(await screen.findByLabelText("새 비밀값")).toHaveValue("");
    expect(screen.getByRole("button", { name: "이전 값으로 롤백" })).toBeDisabled();
  });

  it("restores the category filter from the URL", async () => {
    mockApi({ "GET /admin/settings/effective": () => effectiveSettings });
    renderPage("/system/settings?category=logging");

    expect(await screen.findByText("logging.raw_bodies")).toBeVisible();
    expect(screen.queryByText("clickhouse.url")).not.toBeInTheDocument();
  });

  it("has no automated accessibility violations", async () => {
    mockApi({ "GET /admin/settings/effective": () => effectiveSettings });
    const { container } = renderPage();

    await screen.findByText("clickhouse.url");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});

describe("SystemSettingsPage — 콘솔 전환", () => {
  it("edits a feature rollout status and warns that a refresh is required", async () => {
    const api = mockApi({
      "GET /admin/settings/effective": () => effectiveSettings,
      "PUT /admin/settings/by-key/ui.app.feature.system.settings.status": () =>
        consoleFeatureSetting("status", "preview"),
    });
    const user = userEvent.setup();
    renderPage("/system/settings?tab=console");

    expect(await screen.findByText("ui.app.enabled")).toBeVisible();
    expect(screen.getAllByText("변경 후 새로고침이 필요합니다.").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "시스템 설정 전환 설정 편집" }));
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("전환 상태"), "preview");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));

    await waitFor(() =>
      expect(api.bodies("PUT /admin/settings/by-key/ui.app.feature.system.settings.status")).toEqual([
        { value: "preview" },
      ]),
    );
  });
});

describe("SystemSettingsPage — 시스템 오류", () => {
  it("restores the tab from the URL and clears the log after confirmation", async () => {
    const api = mockApi({
      "GET /admin/system-errors": () => ({
        errors: [
          {
            id: "err_1",
            component: "retention",
            error_message: "Retention rollup failed",
            created_at: "2026-09-06T10:00:00Z",
          },
        ],
      }),
      "POST /admin/system-errors/clear": () => ({ status: "cleared" }),
    });
    const user = userEvent.setup();
    renderPage("/system/settings?tab=errors");

    expect(await screen.findByText("Retention rollup failed")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /전체 비우기/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "전체 비우기" }));

    await waitFor(() =>
      expect(api.calls.some((call) => call.key === "POST /admin/system-errors/clear")).toBe(true),
    );
  });
});

describe("SystemSettingsPage — 데이터·알림 운영", () => {
  const retention = {
    request_days: 90,
    prompt_days: 30,
    response_days: 30,
    requests: 1200,
    prompts: 400,
    responses: 380,
    last_run_at: "2026-09-05T00:00:00Z",
    last_deleted: 12,
  };
  const fallback = {
    path: "/data/fallback.ndjson",
    exists: true,
    bytes: 2048,
    lines: 7,
    modified_at: "2026-09-06T00:00:00Z",
  };
  const notifications = {
    enabled: true,
    webhook_url: "https://mm.example.com/hooks/abcdefghijklmnop",
    channel: "ops",
    events: ["cost"],
    available_events: ["cost", "secret", "approval", "provider"],
  };

  it("runs the retention sweep with a reason and never shows the stored webhook", async () => {
    const api = mockApi({
      "GET /admin/retention": () => retention,
      "POST /admin/retention": () => retention,
      "GET /admin/fallback": () => fallback,
      "GET /admin/notifications/mattermost": () => notifications,
    });
    const user = userEvent.setup();
    renderPage("/system/settings?tab=operations");

    expect(await screen.findByText("/data/fallback.ndjson")).toBeVisible();
    expect(screen.getByText("Webhook 설정됨")).toBeVisible();
    expect(screen.queryByDisplayValue(notifications.webhook_url)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "지금 정리 실행" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/변경 사유/), "월간 정리");
    await user.click(within(dialog).getByRole("button", { name: "정리 실행" }));

    await waitFor(() => expect(api.calls.some((call) => call.key === "POST /admin/retention")).toBe(true));
  });
});

describe("SystemSettingsPage — 변경 세트", () => {
  function changeSet(overrides: Record<string, unknown> = {}) {
    return {
      id: "cset_1",
      title: "ClickHouse 이전",
      description: "새 노드로 이전",
      status: "pending",
      items: [{ kind: "setting", key: "clickhouse.url", value: "http://ch2:8123", note: "" }],
      prior: [],
      canary_scope: "",
      created_by: "operator@example.com",
      created_at: "2026-09-05T00:00:00Z",
      updated_at: "2026-09-05T00:00:00Z",
      applied_at: "",
      ...overrides,
    };
  }

  const changeSets = { change_sets: [changeSet()] };

  async function openDetail(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: /상세/ }));
    return screen.findByRole("dialog");
  }

  it("creates a change set", async () => {
    const api = mockApi({
      "GET /admin/change-sets": () => changeSets,
      "POST /admin/change-sets": () => ({ id: "cset_2", status: "draft" }),
    });
    const user = userEvent.setup();
    renderPage("/system/settings?tab=changesets");

    expect(await screen.findByText("ClickHouse 이전")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /새 변경 세트/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/제목/), "로그 보존 단축");
    await user.click(within(dialog).getByRole("button", { name: "만들기" }));

    await waitFor(() =>
      expect(api.bodies("POST /admin/change-sets")).toEqual([
        { title: "로그 보존 단축", description: "", canary_scope: "", items: [] },
      ]),
    );
  });

  it("shows the dry run comparison before anything is applied", async () => {
    mockApi({
      "GET /admin/change-sets": () => changeSets,
      "POST /admin/change-sets/cset_1/dryrun": () => ({
        change_set_id: "cset_1",
        status: "pending",
        checks: [
          {
            kind: "setting",
            key: "clickhouse.url",
            current: "http://clickhouse:8123",
            proposed: "http://ch2:8123",
            source: "db_setting",
            changed: true,
            valid: true,
            restart_required: true,
          },
        ],
        changed_count: 1,
        invalid_count: 0,
        restart_required: true,
        canary_scope: "",
        note: "setting 변경은 전역 적용입니다",
      }),
    });
    const user = userEvent.setup();
    renderPage("/system/settings?tab=changesets");

    const sheet = await openDetail(user);
    await user.click(within(sheet).getByRole("button", { name: "미리보기" }));

    expect(await within(sheet).findByText("변경 1건 · 오류 0건")).toBeVisible();
    expect(within(sheet).getByText("http://clickhouse:8123")).toBeVisible();
    expect(within(sheet).getByText("재시작 필요")).toBeVisible();
  });

  it("approves a pending change set with the reviewer note", async () => {
    const api = mockApi({
      "GET /admin/change-sets": () => changeSets,
      "GET /admin/settings/effective": () => effectiveSettings,
      "POST /admin/change-sets/cset_1/approve": () => changeSet({ status: "approved" }),
    });
    const user = userEvent.setup();
    renderPage("/system/settings?tab=changesets");

    const sheet = await openDetail(user);
    expect(within(sheet).getByRole("button", { name: "검토 제출" })).toBeDisabled();
    await user.click(within(sheet).getByRole("button", { name: "승인" }));

    const confirm = await screen.findByRole("dialog", { name: "변경 세트를 승인할까요?" });
    await user.type(within(confirm).getByLabelText(/변경 사유/), "용량 확보");
    await user.click(within(confirm).getByRole("button", { name: "승인" }));

    await waitFor(() =>
      expect(api.bodies("POST /admin/change-sets/cset_1/approve")).toEqual([{ note: "용량 확보" }]),
    );
  });

  it("applies an approved change set behind a danger confirmation", async () => {
    const api = mockApi({
      "GET /admin/change-sets": () => ({ change_sets: [changeSet({ status: "approved" })] }),
      "GET /admin/settings/effective": () => effectiveSettings,
      "POST /admin/change-sets/cset_1/apply": () => ({
        status: "applied",
        applied_count: 1,
        change_set: changeSet({ status: "applied" }),
      }),
    });
    const user = userEvent.setup();
    renderPage("/system/settings?tab=changesets");

    const sheet = await openDetail(user);
    await user.click(within(sheet).getByRole("button", { name: "적용" }));

    const confirm = await screen.findByRole("dialog", { name: "설정을 실제로 적용할까요?" });
    await user.click(within(confirm).getByRole("button", { name: "적용" }));
    expect(api.bodies("POST /admin/change-sets/cset_1/apply")).toHaveLength(0);

    await user.type(within(confirm).getByLabelText(/변경 사유/), "승인 완료");
    await user.click(within(confirm).getByRole("button", { name: "적용" }));

    await waitFor(() =>
      expect(api.bodies("POST /admin/change-sets/cset_1/apply")).toEqual([{ note: "승인 완료" }]),
    );
  });

  it("rolls back an applied change set", async () => {
    const api = mockApi({
      "GET /admin/change-sets": () => ({ change_sets: [changeSet({ status: "applied" })] }),
      "GET /admin/settings/effective": () => effectiveSettings,
      "POST /admin/change-sets/cset_1/rollback": () => ({
        status: "rolled_back",
        restored_count: 1,
        change_set: changeSet({ status: "rolled_back" }),
      }),
    });
    const user = userEvent.setup();
    renderPage("/system/settings?tab=changesets");

    const sheet = await openDetail(user);
    expect(within(sheet).getByRole("button", { name: "적용" })).toBeDisabled();
    await user.click(within(sheet).getByRole("button", { name: "롤백" }));

    const confirm = await screen.findByRole("dialog", { name: "적용 전 값으로 되돌릴까요?" });
    await user.type(within(confirm).getByLabelText(/변경 사유/), "성능 저하");
    await user.click(within(confirm).getByRole("button", { name: "롤백" }));

    await waitFor(() =>
      expect(api.bodies("POST /admin/change-sets/cset_1/rollback")).toEqual([{ note: "성능 저하" }]),
    );
  });

  it("deletes a change set and closes the detail panel", async () => {
    const api = mockApi({
      "GET /admin/change-sets": () => changeSets,
      "GET /admin/settings/effective": () => effectiveSettings,
      "DELETE /admin/change-sets/cset_1": () => ({ status: "deleted" }),
    });
    const user = userEvent.setup();
    renderPage("/system/settings?tab=changesets");

    const sheet = await openDetail(user);
    await user.click(within(sheet).getByRole("button", { name: "삭제" }));

    const confirm = await screen.findByRole("dialog", { name: "변경 세트를 삭제할까요?" });
    await user.type(within(confirm).getByLabelText(/변경 사유/), "중복 등록");
    await user.click(within(confirm).getByRole("button", { name: "삭제" }));

    await waitFor(() =>
      expect(api.calls.some((call) => call.key === "DELETE /admin/change-sets/cset_1")).toBe(true),
    );
  });

  it("disables every lifecycle action for a read-only operator", async () => {
    authState.scopes = ["admin:read"];
    mockApi({ "GET /admin/change-sets": () => changeSets });
    const user = userEvent.setup();
    renderPage("/system/settings?tab=changesets");

    const sheet = await openDetail(user);
    for (const label of ["검토 제출", "승인", "적용", "롤백", "삭제"]) {
      expect(within(sheet).getByRole("button", { name: label })).toBeDisabled();
    }
  });
});

describe("SystemSettingsPage — SSO", () => {
  const ssoConfig = {
    enabled: true,
    issuer_url: "https://keycloak.example.com/realms/main",
    client_id: "vibe-console",
    client_secret_set: true,
    redirect_uri: "https://gateway.example.com/auth/keycloak/callback",
    scopes: ["openid", "profile"],
    default_role: "viewer",
    role_claim: "roles",
    group_claim: "groups",
    allow_local_login: true,
    role_map: { "kc-admin": "admin" },
    role_map_default: { "kc-admin": "admin" },
    role_map_custom: true,
    source: "db",
    db_backed: true,
    updated_at: "2026-09-04T00:00:00Z",
    updated_by: "operator@example.com",
    version: 4,
  };

  it("never echoes the client secret and confirms before saving", async () => {
    const api = mockApi({
      "GET /admin/sso/keycloak/config": () => ssoConfig,
      "GET /admin/roles": () => ({
        roles: [
          { role: "admin", description: "관리자", is_system: true },
          { role: "viewer", description: "조회자", is_system: true },
        ],
      }),
      "PUT /admin/sso/keycloak/config": () => undefined,
    });
    const user = userEvent.setup();
    renderPage("/system/settings?tab=sso");

    expect(await screen.findByText("설정됨 (표시하지 않음)")).toBeVisible();
    expect(screen.getByLabelText("Client Secret")).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "SSO 설정 저장" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));

    await waitFor(() => expect(api.bodies("PUT /admin/sso/keycloak/config")).toHaveLength(1));
    const [body] = api.bodies("PUT /admin/sso/keycloak/config");
    expect(body).toMatchObject({
      enabled: true,
      issuer_url: "https://keycloak.example.com/realms/main",
      allow_local_login: true,
      role_map: { "kc-admin": "admin" },
      expected_version: 4,
    });
    expect(body).not.toHaveProperty("client_secret");
  });
});
