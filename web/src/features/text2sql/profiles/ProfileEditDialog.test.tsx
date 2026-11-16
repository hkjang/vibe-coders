import { useState } from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { testAuth } from "@/test/auth";
import { renderScreen } from "@/test/render";
import { FeatureAccessHarness } from "@/test/feature-access";
import { mockApi, type ApiHandler } from "@/test/api";
import { AppError } from "@/shared/api/error";
import { profileReviewSchema, type ReviewedProfile } from "@/shared/api/domains/text2sql-profile-review";
import { usePreferences } from "@/shared/stores/preferences";
import { Text2SqlPage } from "../overview/Text2SqlPage";
import { workspaceOverview } from "../overview/text2sql-workspace-fixture";
const state = vi.hoisted(() => ({ auth: {} as ReturnType<typeof testAuth> }));
vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => state.auth }));
const fixtureProfile = workspaceOverview.db_profiles[0];
if (!fixtureProfile) throw new Error("Missing profile fixture");
const row: ReviewedProfile = {
  ...fixtureProfile,
  mode: "execute",
  revision: "a".repeat(64),
};
const snapshot = (profile: ReviewedProfile | null = row) => ({
  review_supported: true,
  profile,
  revision: profile?.revision ?? "absent",
});
beforeEach(() => {
  state.auth = testAuth({ user: { team_id: "alpha" } });
  usePreferences.setState({ refreshInterval: 0 });
});
function setup(overrides: Record<string, ApiHandler> = {}) {
  const api = mockApi({
    "GET /admin/text2sql": () => ({ ...workspaceOverview, db_profiles: [row] }),
    "GET /admin/text2sql/features": () => ({ features: [] }),
    "GET /admin/text2sql/connections": () => ({ connections: [] }),
    "GET /admin/text2sql/kill-switch": () => ({ disabled: false, config_enabled: true }),
    "GET /admin/text2sql/profiles": () => snapshot(),
    "PUT /admin/text2sql/profiles": ({ body }) => ({
      profile: { ...(body as object), updated_at: "2026-11-16T00:00:00Z", revision: "b".repeat(64) },
    }),
    ...overrides,
  });
  let redraw = () => {};
  function Host() {
    const [, update] = useState(0);
    redraw = () => update((value) => value + 1);
    return (
      <FeatureAccessHarness featureId="text2sql.overview">
        <Text2SqlPage />
      </FeatureAccessHarness>
    );
  }
  return { ...renderScreen(<Host />, { route: "/text2sql?tab=runtime" }), api, redraw: () => act(redraw) };
}
async function edit() {
  const table = await screen.findByRole("table", { name: "런타임 Text2SQL 프로필" });
  await userEvent.click(await within(table).findByRole("button", { name: "수정" }));
  const dialog = await screen.findByRole("dialog", { name: "런타임 프로필 수정" });
  await within(dialog).findByLabelText("업스트림 모델");
  await waitFor(() => expect(within(dialog).getByLabelText("업스트림 모델")).toHaveFocus());
  return dialog;
}
async function prepare(dialog: HTMLElement) {
  await userEvent.clear(within(dialog).getByLabelText("업스트림 모델"));
  await userEvent.type(within(dialog).getByLabelText("업스트림 모델"), "candidate-model");
  await userEvent.type(within(dialog).getByLabelText(/변경 사유/u), "정산 지연 개선");
  await userEvent.click(within(dialog).getByRole("button", { name: "변경 검토" }));
  return within(dialog).findByRole("button", { name: "검토한 변경 저장" });
}
it("편집 기준을 고정하고 변경 비교·사유·예상 버전을 PUT으로 저장한다", async () => {
  const view = setup();
  const dialog = await edit();
  expect(within(dialog).getByLabelText(/가상 모델/u)).toHaveAttribute("readonly");
  const save = await prepare(dialog);
  expect(await within(dialog).findByRole("heading", { name: "프로필 변경 검토" })).toHaveFocus();
  const diff = within(dialog).getByRole("table", { name: "변경 전후 설정" });
  expect(within(diff).getByText("gpt-4o")).toBeVisible();
  expect(within(diff).getByText("candidate-model")).toBeVisible();
  await act(async () => {
    await view.client.invalidateQueries({ queryKey: ["text2sql", "overview"] });
  });
  await userEvent.click(save);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(view.api.bodies("PUT /admin/text2sql/profiles")).toEqual([
    {
      virtual_model: row.virtual_model,
      mode: "execute",
      upstream_model: "candidate-model",
      summary_model: "",
      schema_name: "analytics",
      exec_connection_id: "analytics_db",
      enabled: true,
      expected_revision: row.revision,
      reason: "정산 지연 개선",
    },
  ]);
  expect(view.api.bodies("POST /admin/text2sql/profiles")).toEqual([]);
  expect(screen.getByRole("button", { name: "수정" })).toHaveFocus();
});
it("충돌은 자동 재시도하지 않고 최신 기준의 차이를 다시 확인한다", async () => {
  let current = row;
  let saves = 0;
  const view = setup({
    "GET /admin/text2sql/profiles": () => snapshot(current),
    "PUT /admin/text2sql/profiles": () => {
      if (++saves === 1) {
        current = { ...row, upstream_model: "other-admin", revision: "b".repeat(64) };
        throw new AppError("private-server-content", {
          kind: "http",
          status: 409,
          code: "text2sql_profile_conflict",
          requestId: "req_conflict",
        });
      }
      return { profile: { ...current, upstream_model: "candidate-model" } };
    },
  });
  const dialog = await edit();
  await userEvent.click(await prepare(dialog));
  expect(await within(dialog).findByText(/다른 변경이 확인되었습니다/u)).toBeVisible();
  expect(within(dialog).getByRole("button", { name: "검토한 변경 저장" })).toBeDisabled();
  expect(view.api.bodies("PUT /admin/text2sql/profiles")).toHaveLength(1);
  await userEvent.click(within(dialog).getByRole("button", { name: "최신 기준으로 다시 검토" }));
  expect(await within(dialog).findByText("other-admin")).toBeVisible();
  expect(within(dialog).getByText("candidate-model")).toBeVisible();
  await userEvent.click(within(dialog).getByRole("button", { name: "검토한 변경 저장" }));
  await waitFor(() => expect(view.api.bodies("PUT /admin/text2sql/profiles")).toHaveLength(2));
  expect(view.api.bodies("PUT /admin/text2sql/profiles")[1]).toMatchObject({
    expected_revision: "b".repeat(64),
    upstream_model: "candidate-model",
    reason: "정산 지연 개선",
  });
  expect(screen.queryByText("private-server-content")).not.toBeInTheDocument();
});
it("쓰기 권한이 회수되면 검토 초안을 유지하며 강제 제출도 거부한다", async () => {
  const view = setup();
  const dialog = await edit();
  await prepare(dialog);
  state.auth = testAuth({ scopes: ["admin:read"], user: { team_id: "alpha" } });
  view.redraw();
  const save = within(dialog).getByRole("button", { name: "검토한 변경 저장" });
  expect(save).toBeDisabled();
  save.removeAttribute("disabled");
  const form = dialog.querySelector("form");
  if (!form) throw new Error("Missing profile form");
  fireEvent.submit(form);
  await act(async () => {});
  expect(view.api.bodies("PUT /admin/text2sql/profiles")).toEqual([]);
  expect(within(dialog).getByText("candidate-model")).toBeVisible();
  expect(within(dialog).getByRole("button", { name: "취소" })).toHaveFocus();
});
it("조회 중 쓰기 권한이 회수되면 비활성 입력 대신 취소 버튼으로 포커스를 옮긴다", async () => {
  let finish!: (value: unknown) => void;
  const view = setup({
    "GET /admin/text2sql/profiles": () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await userEvent.click(await screen.findByRole("button", { name: "수정" }));
  expect(await screen.findByText("프로필 조회 중")).toBeVisible();
  state.auth = testAuth({ scopes: ["admin:read"], user: { team_id: "alpha" } });
  view.redraw();
  await act(async () => finish(snapshot()));
  await screen.findByLabelText("업스트림 모델");
  const dialog = screen.getByRole("dialog", { name: "런타임 프로필 수정" });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "취소" })).toHaveFocus());
  expect(within(dialog).getByLabelText("업스트림 모델")).toBeDisabled();
  expect(within(dialog).getByRole("button", { name: "변경 검토" })).toBeDisabled();
  expect(view.api.bodies("PUT /admin/text2sql/profiles")).toEqual([]);
});
it("일시적 재조회 실패 후에도 초안과 검토 기준을 유지한다", async () => {
  let failRefresh = false;
  let current = row;
  const view = setup({
    "GET /admin/text2sql/profiles": () => {
      if (failRefresh)
        throw new AppError("private-refresh-content", {
          kind: "http",
          status: 503,
          requestId: "req_refresh",
        });
      return snapshot(current);
    },
  });
  const dialog = await edit();
  await userEvent.clear(within(dialog).getByLabelText("업스트림 모델"));
  await userEvent.type(within(dialog).getByLabelText("업스트림 모델"), "candidate-model");
  await userEvent.type(within(dialog).getByLabelText(/변경 사유/u), "초안 유지 확인");
  failRefresh = true;
  await act(async () => {
    await view.client.invalidateQueries({ queryKey: ["text2sql", "profile-review"] });
  });
  expect(await within(dialog).findByText("최신 프로필 조회 실패")).toBeVisible();
  expect(within(dialog).getByLabelText("업스트림 모델")).toHaveValue("candidate-model");
  expect(within(dialog).getByText(/req_refresh/u)).toBeVisible();
  expect(screen.queryByText("private-refresh-content")).not.toBeInTheDocument();
  failRefresh = false;
  current = { ...row, upstream_model: "other-admin", revision: "b".repeat(64) };
  await act(async () => {
    await view.client.invalidateQueries({ queryKey: ["text2sql", "profile-review"] });
  });
  await waitFor(() => expect(within(dialog).queryByText("최신 프로필 조회 실패")).not.toBeInTheDocument());
  await userEvent.click(within(dialog).getByRole("button", { name: "변경 검토" }));
  expect(await within(dialog).findByText("gpt-4o")).toBeVisible();
  expect(within(dialog).queryByText("other-admin")).not.toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "검토한 변경 저장" }));
  await waitFor(() => expect(view.api.bodies("PUT /admin/text2sql/profiles")).toHaveLength(1));
  expect(view.api.bodies("PUT /admin/text2sql/profiles")[0]).toMatchObject({
    expected_revision: row.revision,
    upstream_model: "candidate-model",
  });
});
it.each([401, 403])("재조회 %i 응답은 기존 편집 초안과 검토 기준을 폐기한다", async (status) => {
  let denied = false;
  const view = setup({
    "GET /admin/text2sql/profiles": () => {
      if (denied) throw new AppError("private-denial", { kind: "http", status });
      return snapshot();
    },
  });
  const dialog = await edit();
  await prepare(dialog);
  denied = true;
  await act(async () => {
    await view.client.invalidateQueries({ queryKey: ["text2sql", "profile-review"] });
  });
  expect(await screen.findByText("프로필을 확인할 수 없습니다")).toBeVisible();
  expect(screen.queryByText("candidate-model")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "검토한 변경 저장" })).not.toBeInTheDocument();
  expect(view.api.bodies("PUT /admin/text2sql/profiles")).toEqual([]);
});
it("중복 저장과 계정 전환 뒤 늦은 성공 알림을 막는다", async () => {
  let finish!: (value: unknown) => void;
  const success = vi.spyOn(toast, "success");
  const view = setup({
    "PUT /admin/text2sql/profiles": () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const dialog = await edit();
  const save = await prepare(dialog);
  await userEvent.dblClick(save);
  await waitFor(() => expect(view.api.bodies("PUT /admin/text2sql/profiles")).toHaveLength(1));
  state.auth = testAuth({ user: { team_id: "beta" } });
  view.redraw();
  await act(async () => finish({ profile: row }));
  expect(success).not.toHaveBeenCalled();
  expect(screen.queryByText("candidate-model")).not.toBeInTheDocument();
});
it("변경 사유를 검증하고 미적용이 서버 기본 설정 사용임을 알린다", async () => {
  setup();
  const dialog = await edit();
  await userEvent.click(within(dialog).getByLabelText("프로필 적용"));
  await userEvent.click(within(dialog).getByRole("button", { name: "변경 검토" }));
  expect(await within(dialog).findByText("변경 사유를 입력하세요.")).toBeVisible();
  expect(within(dialog).getByLabelText(/변경 사유/u)).toHaveFocus();
  await userEvent.type(within(dialog).getByLabelText(/변경 사유/u), "기본 설정 복귀");
  await userEvent.click(within(dialog).getByRole("button", { name: "변경 검토" }));
  expect(await within(dialog).findByText("프로필 미적용 시 서버 기본 설정 사용")).toBeVisible();
});
it("구버전 응답과 서로 다른 검토 버전은 계약 검증에서 거부한다", () => {
  for (const response of [
    { profiles: [row] },
    { ...snapshot(), review_supported: false },
    { ...snapshot(), revision: "b".repeat(64) },
    { ...snapshot(null), revision: row.revision },
  ])
    expect(profileReviewSchema.safeParse(response).success).toBe(false);
});
it("이미 있는 이름을 추가하면 덮어쓰지 않고 수정 화면을 안내한다", async () => {
  const view = setup();
  await userEvent.click(await screen.findByRole("button", { name: "프로필 추가" }));
  const dialog = await screen.findByRole("dialog", { name: "런타임 프로필 추가" });
  await userEvent.type(within(dialog).getByLabelText(/가상 모델/u), row.virtual_model);
  await userEvent.type(within(dialog).getByLabelText(/변경 사유/u), "새 프로필 등록");
  await userEvent.click(within(dialog).getByRole("button", { name: "변경 검토" }));
  expect(await within(dialog).findByText(/같은 이름의 프로필/u)).toBeVisible();
  expect(view.api.bodies("PUT /admin/text2sql/profiles")).toEqual([]);
});

it("검토 화면의 취소는 초안 폐기를 확인하고 계속 편집을 지원한다", async () => {
  const view = setup();
  const dialog = await edit();
  await prepare(dialog);
  await userEvent.click(within(dialog).getByRole("button", { name: "취소" }));
  await userEvent.click(await screen.findByRole("button", { name: "계속 편집" }));
  expect(within(dialog).getByText("candidate-model")).toBeVisible();
  await userEvent.click(within(dialog).getByRole("button", { name: "취소" }));
  await userEvent.click(await screen.findByRole("button", { name: "변경 버리기" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(view.api.bodies("PUT /admin/text2sql/profiles")).toEqual([]);
});
