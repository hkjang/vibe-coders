import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { describe, expect, it, vi } from "vitest";

import { SystemSettingsPage } from "@/features/system/settings/SystemSettingsPage";
import { systemSettingsKeys } from "@/features/system/settings/use-system-settings";
import type { EffectiveSetting } from "@/shared/api/domains/system.schemas";
import { AppError } from "@/shared/api/error";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: ["admin:read", "admin:write"] }) };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const base: EffectiveSetting = {
  key: "clickhouse.url",
  category: "clickhouse",
  type: "string",
  description: "주소",
  is_secret: false,
  is_set: true,
  read_only: false,
  restart_required: false,
  source: "admin",
  value: "old-value",
  version: 3,
  updated_at: "2026-09-01T00:00:00Z",
  can_write: true,
};
const cases = [
  {
    tab: "runtime",
    setting: base,
    openLabel: "clickhouse.url 설정 열기",
    draft: "draft-value",
    next: "new-value",
  },
  {
    tab: "console",
    setting: { ...base, key: "ui.app.enabled", category: "ui.app", type: "bool", value: "true" },
    openLabel: "신규 콘솔 사용 편집",
    draft: "false",
    next: "false",
  },
] as const;

function history(setting: EffectiveSetting, id = "history-open", count = 1) {
  return {
    history: [
      {
        id,
        key: setting.key,
        old_value_json: '"previous"',
        new_value_json: JSON.stringify(setting.value),
        changed_at: setting.updated_at,
        history_count: count,
      },
    ],
  };
}

function setup(fixture: (typeof cases)[number], overrides: Record<string, ApiHandler> = {}) {
  const state = { setting: { ...fixture.setting } as EffectiveSetting };
  const api = mockApi({
    "GET /admin/settings/effective": () => ({ settings: [state.setting] }),
    "GET /admin/settings/history": () => history(state.setting),
    "GET /admin/ui-telemetry/summary": () => ({
      enabled: false,
      days: 7,
      from: "",
      to: "",
      retention_days: 30,
      visit_limit: 100000,
      features: [],
    }),
    ...overrides,
  });
  const view = renderScreen(<SystemSettingsPage />, {
    path: "/system/settings",
    route: `/system/settings?tab=${fixture.tab}`,
  });
  return { ...view, api, state };
}

async function changeValue(user: ReturnType<typeof userEvent.setup>, value: string) {
  const select = screen.queryByRole("combobox", { name: "새 값" });
  if (select) await user.selectOptions(select, value);
  else {
    const input = screen.getByRole("textbox", { name: "새 값" });
    await user.clear(input);
    await user.type(input, value);
  }
}

describe.each(cases)("$tab 설정 저장 계약", (fixture) => {
  it("첫 오버라이드 이력에 이전 값이 없으면 롤백만 잠그고 이유를 안내한다", async () => {
    const user = userEvent.setup();
    const { api } = setup(fixture, {
      "GET /admin/settings/history": () => ({
        history: history(fixture.setting).history.map((entry) => ({ ...entry, old_value_json: "" })),
      }),
    });
    await user.click(await screen.findByRole("button", { name: fixture.openLabel }));
    expect(await screen.findByText("이 변경 이력에 이전 값이 없어 롤백할 수 없습니다.")).toBeVisible();
    expect(screen.getByRole("button", { name: "이전 값으로 롤백" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "기본값(환경변수)으로 되돌리기" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "저장" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "이전 값으로 롤백" }));
    expect(api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
  });

  it.each([
    ["revert", "saved"],
    ["rollback", "saved"],
    ["revert", "conflict"],
    ["rollback", "conflict"],
    ["revert", "failure"],
    ["rollback", "failure"],
  ] as const)("%s 결과 %s에 따라 기존 반영 대기 경고를 정확히 유지하거나 지운다", async (kind, outcome) => {
    const user = userEvent.setup();
    const saveEndpoint = `PUT /admin/settings/by-key/${fixture.setting.key}`;
    const recoveryEndpoint =
      kind === "revert"
        ? `DELETE /admin/settings/by-key/${fixture.setting.key}`
        : "POST /admin/settings/rollback";
    const pendingTitle = "설정은 저장됐으며 런타임 반영을 기다리고 있습니다.";
    const { api } = setup(fixture, {
      [saveEndpoint]: () => {
        throw new AppError("persisted", { kind: "http", status: 503, code: "setting_reload_pending" });
      },
      [recoveryEndpoint]: () => {
        if (outcome !== "saved") throw apiFailure("recovery failed", outcome === "conflict" ? 409 : 500);
        return fixture.setting;
      },
    });
    await user.click(await screen.findByRole("button", { name: fixture.openLabel }));
    await changeValue(user, fixture.draft);
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(await screen.findByText(pendingTitle)).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: fixture.openLabel }));
    const action = screen.getByRole("button", {
      name: kind === "revert" ? "기본값(환경변수)으로 되돌리기" : "이전 값으로 롤백",
    });
    await waitFor(() => expect(action).toBeEnabled());
    await user.click(action);
    await user.type(screen.getByRole("textbox", { name: "변경 사유" }), "후속 복구 검토");
    await user.click(screen.getByRole("button", { name: kind === "revert" ? "되돌리기" : "롤백" }));
    if (outcome === "saved") {
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(screen.queryByText(pendingTitle)).not.toBeInTheDocument();
      expect(toast.success).toHaveBeenCalledOnce();
    } else {
      expect(await screen.findByRole("alert")).toBeVisible();
      expect(screen.getByText(pendingTitle)).toBeVisible();
      expect(screen.getByRole("textbox", { name: "변경 사유" })).toHaveValue("후속 복구 검토");
      expect(toast.success).not.toHaveBeenCalled();
    }
    expect(api.bodies(saveEndpoint)).toHaveLength(1);
    expect(api.calls.filter((call) => call.key === recoveryEndpoint)).toHaveLength(1);
  });

  it("실시간 조회가 바뀌어도 열린 CAS 버전으로 보내고 409 초안을 유지한다", async () => {
    const user = userEvent.setup();
    const endpoint = `PUT /admin/settings/by-key/${fixture.setting.key}`;
    const { api, client, state } = setup(fixture, {
      [endpoint]: () => {
        throw apiFailure("conflict", 409, "req-cas");
      },
    });
    await user.click(await screen.findByRole("button", { name: fixture.openLabel }));
    await changeValue(user, fixture.draft);
    await user.type(screen.getByRole("textbox", { name: "변경 사유" }), "열린 초안");
    state.setting = { ...state.setting, value: fixture.next, version: 8 };
    act(() => client.setQueryData(systemSettingsKeys.effective, { settings: [state.setting] }));
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(await screen.findByText("다른 작업자가 설정을 변경했습니다.")).toBeVisible();
    expect(screen.getByLabelText("새 값")).toHaveValue(fixture.draft);
    expect(screen.getByRole("textbox", { name: "변경 사유" })).toHaveValue("열린 초안");
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
    expect(api.bodies(endpoint)).toEqual([
      { value: fixture.draft, reason: "열린 초안", expected_version: 3 },
    ]);
    expect(api.calls.filter((call) => call.key === "GET /admin/settings/effective")).toHaveLength(2);
    await user.keyboard("{Escape}");
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "변경 버리기" }),
    );
    await user.click(screen.getByRole("button", { name: fixture.openLabel }));
    expect(screen.getByLabelText("새 값")).toHaveValue(fixture.next);
    expect(screen.getByRole("button", { name: "저장" })).toBeEnabled();
  });

  it("첫 DB override도 expected_version 0을 명시하고 성공 후 경고 없이 닫는다", async () => {
    const user = userEvent.setup();
    const endpoint = `PUT /admin/settings/by-key/${fixture.setting.key}`;
    const initial = { ...fixture.setting, source: "env", version: undefined, updated_at: undefined };
    const { api } = setup(fixture, {
      "GET /admin/settings/effective": () => ({ settings: [initial] }),
      [endpoint]: () => fixture.setting,
    });
    await user.click(await screen.findByRole("button", { name: fixture.openLabel }));
    await changeValue(user, fixture.draft);
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(api.bodies(endpoint)).toEqual([{ value: fixture.draft, expected_version: 0 }]),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("저장 완료 후 reload_pending은 닫고 알리며 재저장하지 않는다", async () => {
    const user = userEvent.setup();
    const endpoint = `PUT /admin/settings/by-key/${fixture.setting.key}`;
    const { api } = setup(fixture, {
      [endpoint]: () => {
        throw new AppError("pending", {
          kind: "http",
          status: 503,
          code: "setting_reload_pending",
          requestId: "req-pending",
        });
      },
    });
    await user.click(await screen.findByRole("button", { name: fixture.openLabel }));
    await changeValue(user, fixture.draft);
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(await screen.findByText("설정은 저장됐으며 런타임 반영을 기다리고 있습니다.")).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.bodies(endpoint)).toHaveLength(1);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it.each(["revert", "rollback"] as const)(
    "%s는 초안 폐기 뒤 사유와 열린 snapshot guard를 전송한다",
    async (kind) => {
      const user = userEvent.setup();
      let finish!: () => void;
      const response = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const endpoint =
        kind === "revert"
          ? `DELETE /admin/settings/by-key/${fixture.setting.key}`
          : "POST /admin/settings/rollback";
      const { api } = setup(fixture, { [endpoint]: () => response });
      await user.click(await screen.findByRole("button", { name: fixture.openLabel }));
      await user.type(screen.getByRole("textbox", { name: "변경 사유" }), "버릴 수정 사유");
      const action = screen.getByRole("button", {
        name: kind === "revert" ? "기본값(환경변수)으로 되돌리기" : "이전 값으로 롤백",
      });
      await waitFor(() => expect(action).toBeEnabled());
      await user.click(action);
      expect(api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "변경 버리기" }),
      );
      const confirmation = await screen.findByRole("dialog", {
        name: kind === "revert" ? "환경변수 기본값으로 되돌리기" : "이전 값으로 롤백",
      });
      const reason = within(confirmation).getByRole("textbox", { name: "변경 사유" });
      expect(reason).toHaveValue("");
      await user.type(reason, "검토한 복구");
      await user.click(
        within(confirmation).getByRole("button", { name: kind === "revert" ? "되돌리기" : "롤백" }),
      );
      await waitFor(() => expect(api.calls.filter((call) => call.key === endpoint)).toHaveLength(1));
      if (kind === "rollback")
        expect(api.bodies(endpoint)).toEqual([
          {
            key: fixture.setting.key,
            reason: "검토한 복구",
            expected_version: 3,
            expected_updated_at: fixture.setting.updated_at,
            expected_history_id: "history-open",
            expected_history_count: 1,
          },
        ]);
      else
        expect(api.calls.find((call) => call.key === endpoint)?.options.query).toEqual({
          reason: "검토한 복구",
          expected_version: 3,
        });
      expect(reason).toBeDisabled();
      expect(within(confirmation).getByRole("button", { name: "취소" })).toBeDisabled();
      await user.click(within(confirmation).getByRole("button", { name: "처리 중" }));
      expect(api.calls.filter((call) => call.key === endpoint)).toHaveLength(1);
      await act(async () => finish());
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    },
  );
});

describe("복구 이력 snapshot", () => {
  it("JSON 빈 문자열은 복구 가능한 이전 값으로 구분한다", async () => {
    const fixture = cases[0];
    const user = userEvent.setup();
    setup(fixture, {
      "GET /admin/settings/history": () => ({
        history: history(fixture.setting).history.map((entry) => ({
          ...entry,
          old_value_json: JSON.stringify(""),
        })),
      }),
    });
    await user.click(await screen.findByRole("button", { name: fixture.openLabel }));
    await waitFor(() => expect(screen.getByRole("button", { name: "이전 값으로 롤백" })).toBeEnabled());
    expect(screen.queryByText("이 변경 이력에 이전 값이 없어 롤백할 수 없습니다.")).not.toBeInTheDocument();
  });

  it.each([[undefined], [0], [-1], [1.5], [Number.NaN], [Number.MAX_SAFE_INTEGER + 1], [2, 3], [1, 1]])(
    "검증할 수 없는 이력 개수 %j는 롤백만 잠근다",
    async (...counts) => {
      const fixture = cases[0];
      const user = userEvent.setup();
      const { api } = setup(fixture, {
        "GET /admin/settings/history": () => ({
          history: counts.map((count, index) => ({
            ...history(fixture.setting, `row-${index}`).history[0],
            history_count: count,
          })),
        }),
      });
      await user.click(await screen.findByRole("button", { name: fixture.openLabel }));
      expect(await screen.findByText(/변경 이력 검증 정보를 확인할 수 없어/)).toBeVisible();
      expect(screen.getByRole("button", { name: "이전 값으로 롤백" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "기본값(환경변수)으로 되돌리기" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "저장" })).toBeEnabled();
      await user.click(screen.getByRole("button", { name: "이전 값으로 롤백" }));
      expect(api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
    },
  );

  it("오래된 query cache 대신 열린 뒤 새 이력을 기다린 다음 대상 ID를 고정한다", async () => {
    const fixture = cases[0];
    const user = userEvent.setup();
    let release!: (value: ReturnType<typeof history>) => void;
    const pending = new Promise<ReturnType<typeof history>>((resolve) => {
      release = resolve;
    });
    const { api, client } = setup(fixture, {
      "GET /admin/settings/history": () => pending,
      "POST /admin/settings/rollback": () => fixture.setting,
    });
    client.setQueryData(
      systemSettingsKeys.history(fixture.setting.key),
      history(fixture.setting, "cached-old"),
    );
    await user.click(await screen.findByRole("button", { name: fixture.openLabel }));
    expect(screen.getByRole("button", { name: "이전 값으로 롤백" })).toBeDisabled();
    expect(screen.getByText("변경 이력을 불러오는 중입니다.")).toBeVisible();
    expect(screen.queryByText(/아직 변경 이력이 없습니다/)).not.toBeInTheDocument();
    await act(async () => release(history(fixture.setting, "fresh-read", 2)));
    const action = screen.getByRole("button", { name: "이전 값으로 롤백" });
    await waitFor(() => expect(action).toBeEnabled());
    act(() =>
      client.setQueryData(
        systemSettingsKeys.history(fixture.setting.key),
        history(fixture.setting, "later-unreviewed", 3),
      ),
    );
    await user.click(action);
    await user.type(screen.getByRole("textbox", { name: "변경 사유" }), "확인한 이력");
    await user.click(screen.getByRole("button", { name: "롤백" }));
    await waitFor(() =>
      expect(api.bodies("POST /admin/settings/rollback")).toEqual([
        {
          key: fixture.setting.key,
          reason: "확인한 이력",
          expected_version: 3,
          expected_updated_at: fixture.setting.updated_at,
          expected_history_id: "fresh-read",
          expected_history_count: 2,
        },
      ]),
    );
  });

  it("이력 조회 실패를 빈 이력으로 표시하지 않고 성공한 재조회만 확정한다", async () => {
    const fixture = cases[0];
    const user = userEvent.setup();
    let failed = true;
    setup(fixture, {
      "GET /admin/settings/history": () => {
        if (failed) throw apiFailure("history unavailable", 500);
        return { history: [] };
      },
    });
    await user.click(await screen.findByRole("button", { name: fixture.openLabel }));
    const retry = await screen.findByRole("button", { name: "다시 시도" });
    expect(screen.queryByText(/아직 변경 이력이 없습니다/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "이전 값으로 롤백" })).toBeDisabled();
    failed = false;
    await user.click(retry);
    expect(await screen.findByText(/아직 변경 이력이 없습니다/)).toBeVisible();
  });

  it("첫 최신 이력이 열린 값의 시점과 다르면 초안은 유지하고 롤백 검토를 요청한다", async () => {
    const fixture = cases[0];
    const user = userEvent.setup();
    setup(fixture, {
      "GET /admin/settings/history": () =>
        history({ ...fixture.setting, updated_at: "2026-09-02T00:00:00Z" }),
    });
    await user.click(await screen.findByRole("button", { name: fixture.openLabel }));
    expect(await screen.findByText("열린 설정과 최신 변경 이력이 다릅니다.")).toBeVisible();
    await changeValue(user, fixture.draft);
    expect(screen.getByLabelText("새 값")).toHaveValue(fixture.draft);
    expect(screen.getByRole("button", { name: "이전 값으로 롤백" })).toBeDisabled();
  });

  it("환경변수 출처도 검토한 삭제 이력과 버전 0으로 롤백한다", async () => {
    const fixture = cases[0];
    const user = userEvent.setup();
    const initial = { ...fixture.setting, source: "env", version: undefined, updated_at: undefined };
    const { api } = setup(fixture, {
      "GET /admin/settings/effective": () => ({ settings: [initial] }),
      "GET /admin/settings/history": () => ({
        history: [
          {
            id: "deleted-row",
            key: initial.key,
            old_value_json: '"old"',
            new_value_json: "",
            history_count: 2,
          },
        ],
      }),
      "POST /admin/settings/rollback": () => fixture.setting,
    });
    await user.click(await screen.findByRole("button", { name: fixture.openLabel }));
    const action = screen.getByRole("button", { name: "이전 값으로 롤백" });
    await waitFor(() => expect(action).toBeEnabled());
    await user.click(action);
    await user.type(screen.getByRole("textbox", { name: "변경 사유" }), "삭제 취소");
    await user.click(screen.getByRole("button", { name: "롤백" }));
    await waitFor(() =>
      expect(api.bodies("POST /admin/settings/rollback")).toEqual([
        {
          key: initial.key,
          reason: "삭제 취소",
          expected_version: 0,
          expected_updated_at: "",
          expected_history_id: "deleted-row",
          expected_history_count: 2,
        },
      ]),
    );
  });

  it.each([409, 503])("복구 %s는 사유 유지 또는 이미 저장된 결과 안내를 구분한다", async (status) => {
    const fixture = cases[0];
    const user = userEvent.setup();
    const { api } = setup(fixture, {
      "POST /admin/settings/rollback": () => {
        throw new AppError("untrusted", {
          kind: "http",
          status,
          code: status === 503 ? "setting_reload_pending" : "setting_conflict",
        });
      },
    });
    await user.click(await screen.findByRole("button", { name: fixture.openLabel }));
    const action = screen.getByRole("button", { name: "이전 값으로 롤백" });
    await waitFor(() => expect(action).toBeEnabled());
    await user.click(action);
    await user.type(screen.getByRole("textbox", { name: "변경 사유" }), "검토한 이유");
    await user.click(screen.getByRole("button", { name: "롤백" }));
    if (status === 409) {
      expect(await screen.findByText("다른 작업자가 설정을 변경했습니다.")).toBeVisible();
      expect(screen.getByRole("textbox", { name: "변경 사유" })).toHaveValue("검토한 이유");
      expect(screen.getByRole("button", { name: "롤백" })).toBeDisabled();
    } else {
      expect(await screen.findByText("설정은 저장됐으며 런타임 반영을 기다리고 있습니다.")).toBeVisible();
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    }
    expect(api.bodies("POST /admin/settings/rollback")).toHaveLength(1);
    expect(toast.success).not.toHaveBeenCalled();
  });
});
