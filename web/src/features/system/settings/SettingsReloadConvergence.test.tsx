import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { SystemSettingsPage } from "@/features/system/settings/SystemSettingsPage";
import type { EffectiveSetting } from "@/shared/api/domains/system.schemas";
import { AppError } from "@/shared/api/error";
import { mockApi } from "@/test/api";
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
const parents = [
  { tab: "runtime", setting: base, openLabel: "clickhouse.url 설정 열기" },
  {
    tab: "console",
    setting: { ...base, key: "ui.app.enabled", category: "ui.app", type: "bool", value: "true" },
    openLabel: "신규 콘솔 사용 편집",
  },
] as const;
const writes = [
  ...parents.flatMap((parent) =>
    (["save", "revert", "rollback"] as const).map((kind) => ({ ...parent, kind })),
  ),
  {
    tab: "console",
    setting: {
      ...base,
      key: "ui.app.feature.system.settings.status",
      category: "ui.app",
      value: "legacy",
    },
    openLabel: "시스템 설정 전환 설정 편집",
    kind: "feature",
  },
] as const;

it.each(writes)("$tab $kind 응답 직후 자동 조회가 반영 완료이면 경고를 남기지 않는다", async (fixture) => {
  const user = userEvent.setup();
  const endpoint =
    fixture.kind === "feature"
      ? "PUT /admin/settings/bulk"
      : fixture.kind === "rollback"
        ? "POST /admin/settings/rollback"
        : `${fixture.kind === "revert" ? "DELETE" : "PUT"} /admin/settings/by-key/${fixture.setting.key}`;
  let reads = 0;
  const api = mockApi({
    "GET /admin/settings/effective": () => {
      reads += 1;
      return { settings: [fixture.setting], this_pod: { up_to_date: true } };
    },
    "GET /admin/settings/history": () => ({
      history: [
        {
          id: "history-3",
          key: fixture.setting.key,
          old_value_json: '"previous"',
          new_value_json: JSON.stringify(fixture.setting.value),
          changed_at: fixture.setting.updated_at,
          history_count: 1,
        },
      ],
    }),
    "GET /admin/ui-telemetry/summary": () => ({ enabled: false, features: [] }),
    [endpoint]: () => {
      throw new AppError("persisted", {
        kind: "http",
        status: 503,
        code: "setting_reload_pending",
        requestId: "fast-converged",
      });
    },
  });
  renderScreen(<SystemSettingsPage />, {
    path: "/system/settings",
    route: `/system/settings?tab=${fixture.tab}`,
  });
  await user.click(await screen.findByRole("button", { name: fixture.openLabel }));
  if (fixture.kind === "revert" || fixture.kind === "rollback") {
    const action = screen.getByRole("button", {
      name: fixture.kind === "revert" ? "기본값(환경변수)으로 되돌리기" : "이전 값으로 롤백",
    });
    await waitFor(() => expect(action).toBeEnabled());
    await user.click(action);
    await user.type(screen.getByRole("textbox", { name: "변경 사유" }), "복구 검토");
    await user.click(screen.getByRole("button", { name: fixture.kind === "revert" ? "되돌리기" : "롤백" }));
  } else {
    if (fixture.kind === "feature") {
      await user.selectOptions(screen.getByLabelText("전환 상태"), "preview");
    } else if (fixture.tab === "console") {
      await user.selectOptions(screen.getByLabelText("새 값"), "false");
    } else {
      await user.clear(screen.getByLabelText("새 값"));
      await user.type(screen.getByLabelText("새 값"), "new-value");
    }
    await user.click(screen.getByRole("button", { name: "저장" }));
  }
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(reads).toBe(2);
  expect(screen.queryByText("설정은 저장됐으며 런타임 반영을 기다리고 있습니다.")).not.toBeInTheDocument();
  expect(screen.queryByText("요청 ID: fast-converged")).not.toBeInTheDocument();
  expect(api.calls.filter((call) => call.key === endpoint)).toHaveLength(1);
});
