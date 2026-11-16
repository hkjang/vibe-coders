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
import { usePreferences } from "@/shared/stores/preferences";
import { Text2SqlPage } from "../overview/Text2SqlPage";
import { workspaceOverview } from "../overview/text2sql-workspace-fixture";
const state = vi.hoisted(() => ({ auth: {} as ReturnType<typeof testAuth> }));
vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => state.auth }));
const fixture = workspaceOverview.db_profiles[0];
if (!fixture) throw new Error("Missing profile fixture");
const row = { ...fixture, revision: "a".repeat(64) };
const snapshot = (profile: typeof row | null = row) => ({
  review_supported: true,
  profile,
  revision: profile?.revision ?? "absent",
});
const action = "POST /admin/text2sql/profiles/reviewed-delete";
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
    [action]: ({ body }) => ({
      virtual_model: row.virtual_model,
      status: "deleted",
      reviewed_revision: (body as { expected_revision: string }).expected_revision,
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
async function openDelete() {
  const table = await screen.findByRole("table", { name: "런타임 Text2SQL 프로필" });
  await userEvent.click(await within(table).findByRole("button", { name: "삭제" }));
  await screen.findByLabelText(/삭제할 가상 모델 이름/u);
  const dialog = screen.getByRole("dialog", { name: "런타임 프로필 삭제" });
  await waitFor(() =>
    expect(within(dialog).getByRole("heading", { name: "삭제 영향과 현재 설정" })).toHaveFocus(),
  );
  return dialog;
}
async function fill(dialog: HTMLElement) {
  await userEvent.type(within(dialog).getByLabelText(/삭제할 가상 모델 이름/u), row.virtual_model);
  await userEvent.type(within(dialog).getByLabelText(/삭제 사유/u), "이전 설정 정리");
}
it("최신 설정·삭제 영향·이름·사유를 확인하고 정확한 버전으로 삭제한다", async () => {
  const view = setup();
  const dialog = await openDelete();
  expect(within(dialog).getByText("프로필 삭제는 SQL 실행 중지가 아닙니다")).toBeVisible();
  expect(within(dialog).getByRole("table", { name: "삭제할 프로필의 검토 기준" })).toBeVisible();
  await userEvent.click(within(dialog).getByRole("button", { name: "검토한 프로필 삭제" }));
  expect(await within(dialog).findByText("삭제할 가상 모델 이름을 정확히 입력하세요.")).toBeVisible();
  expect(within(dialog).getByLabelText(/삭제할 가상 모델 이름/u)).toHaveFocus();
  expect(view.api.bodies(action)).toEqual([]);
  await fill(dialog);
  await userEvent.click(within(dialog).getByRole("button", { name: "검토한 프로필 삭제" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(view.api.bodies(action)).toEqual([
    {
      virtual_model: row.virtual_model,
      confirmation: row.virtual_model,
      expected_revision: row.revision,
      reason: "이전 설정 정리",
    },
  ]);
  expect(view.api.calls.some((call) => call.key === "DELETE /admin/text2sql/profiles")).toBe(false);
  expect(
    within(screen.getByRole("table", { name: "런타임 Text2SQL 프로필" })).getByRole("button", {
      name: "삭제",
    }),
  ).toHaveFocus();
});
it("이름과 사유를 고치면 이전 오류 문구가 즉시 사라진다", async () => {
  const view = setup();
  const dialog = await openDelete();
  const name = within(dialog).getByLabelText(/삭제할 가상 모델 이름/u);
  const reason = within(dialog).getByLabelText(/삭제 사유/u);
  await userEvent.click(name);
  await userEvent.tab();
  expect(await within(dialog).findByText("삭제할 가상 모델 이름을 정확히 입력하세요.")).toBeVisible();
  await userEvent.type(name, row.virtual_model);
  await waitFor(() =>
    expect(within(dialog).queryByText("삭제할 가상 모델 이름을 정확히 입력하세요.")).not.toBeInTheDocument(),
  );
  await userEvent.click(reason);
  await userEvent.tab();
  expect(await within(dialog).findByText("삭제 사유를 입력하세요.")).toBeVisible();
  await userEvent.type(reason, "이전 설정 정리");
  await waitFor(() => expect(within(dialog).queryByText("삭제 사유를 입력하세요.")).not.toBeInTheDocument());
  expect(view.api.bodies(action)).toEqual([]);
});
it("충돌 후 이전·최신 설정을 비교하고 사유를 유지하며 이름을 다시 확인한다", async () => {
  let current = row;
  let calls = 0;
  const view = setup({
    "GET /admin/text2sql/profiles": () => snapshot(current),
    [action]: () => {
      if (++calls === 1) {
        current = { ...row, upstream_model: "동료 관리자 모델", revision: "b".repeat(64) };
        throw new AppError("private-conflict", {
          kind: "http",
          status: 409,
          code: "text2sql_profile_conflict",
        });
      }
      return { virtual_model: row.virtual_model, status: "deleted", reviewed_revision: current.revision };
    },
  });
  const dialog = await openDelete();
  await fill(dialog);
  await userEvent.click(within(dialog).getByRole("button", { name: "검토한 프로필 삭제" }));
  expect(await within(dialog).findByRole("button", { name: "최신 상태로 다시 검토" })).toBeEnabled();
  expect(view.api.bodies(action)).toHaveLength(1);
  expect(within(dialog).getByRole("button", { name: "검토한 프로필 삭제" })).toBeDisabled();
  await userEvent.click(within(dialog).getByRole("button", { name: "최신 상태로 다시 검토" }));
  expect(await within(dialog).findByText("동료 관리자 모델")).toBeVisible();
  expect(within(dialog).getByText("gpt-4o")).toBeVisible();
  expect(within(dialog).getByLabelText(/삭제할 가상 모델 이름/u)).toHaveValue("");
  expect(within(dialog).getByLabelText(/삭제 사유/u)).toHaveValue("이전 설정 정리");
  await userEvent.click(within(dialog).getByRole("button", { name: "검토한 프로필 삭제" }));
  expect(view.api.bodies(action)).toHaveLength(1);
  await userEvent.type(within(dialog).getByLabelText(/삭제할 가상 모델 이름/u), row.virtual_model);
  await userEvent.click(within(dialog).getByRole("button", { name: "검토한 프로필 삭제" }));
  await waitFor(() => expect(view.api.bodies(action)).toHaveLength(2));
  expect(view.api.bodies(action)[1]).toMatchObject({
    expected_revision: current.revision,
    reason: "이전 설정 정리",
  });
  expect(screen.queryByText("private-conflict")).not.toBeInTheDocument();
});
it("쓰기 권한 회수 후 초안은 보존하고 직접 제출도 막는다", async () => {
  const view = setup();
  const dialog = await openDelete();
  await fill(dialog);
  state.auth = testAuth({ scopes: ["admin:read"], user: { team_id: "alpha" } });
  view.redraw();
  expect(within(dialog).getByLabelText(/삭제 사유/u)).toHaveValue("이전 설정 정리");
  expect(within(dialog).getByRole("button", { name: "취소" })).toHaveFocus();
  const form = dialog.querySelector("form");
  if (!form) throw new Error("Missing deletion form");
  fireEvent.submit(form);
  await act(async () => {});
  expect(view.api.bodies(action)).toEqual([]);
});
it("중복 삭제와 계정 전환 이후 늦은 성공 처리를 막는다", async () => {
  let finish!: (value: unknown) => void;
  const success = vi.spyOn(toast, "success");
  const view = setup({
    [action]: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const dialog = await openDelete();
  await fill(dialog);
  await userEvent.dblClick(within(dialog).getByRole("button", { name: "검토한 프로필 삭제" }));
  await waitFor(() => expect(view.api.bodies(action)).toHaveLength(1));
  state.auth = testAuth({ user: { team_id: "beta" } });
  view.redraw();
  await act(async () =>
    finish({ virtual_model: row.virtual_model, status: "deleted", reviewed_revision: row.revision }),
  );
  expect(success).not.toHaveBeenCalled();
  expect(screen.queryByDisplayValue("이전 설정 정리")).not.toBeInTheDocument();
});
it("구버전 삭제 경로 실패는 재전송하지 않고 이미 삭제된 상태를 안내한다", async () => {
  let current: typeof row | null = row;
  const view = setup({
    "GET /admin/text2sql/profiles": () => snapshot(current),
    [action]: () => {
      throw new AppError("old-route", { kind: "http", status: 404 });
    },
  });
  const dialog = await openDelete();
  await fill(dialog);
  await userEvent.click(within(dialog).getByRole("button", { name: "검토한 프로필 삭제" }));
  await within(dialog).findByRole("button", { name: "최신 상태로 다시 검토" });
  current = null;
  await userEvent.click(within(dialog).getByRole("button", { name: "최신 상태로 다시 검토" }));
  expect(await within(dialog).findByText("프로필이 더 이상 존재하지 않습니다")).toBeVisible();
  expect(within(dialog).getByRole("button", { name: "취소" })).toHaveFocus();
  expect(within(dialog).getByRole("button", { name: "검토한 프로필 삭제" })).toBeDisabled();
  expect(view.api.bodies(action)).toHaveLength(1);
  expect(view.api.calls.some((call) => call.key === "DELETE /admin/text2sql/profiles")).toBe(false);
});
it.each([401, 403])("명시적 재검토 %i 응답은 기존 초안을 제거한다", async (status) => {
  let denied = false;
  const view = setup({
    "GET /admin/text2sql/profiles": () => {
      if (denied) throw new AppError("denied-private", { kind: "http", status });
      return snapshot();
    },
    [action]: () => {
      throw new AppError("conflict", { kind: "http", status: 409, code: "text2sql_profile_conflict" });
    },
  });
  const dialog = await openDelete();
  await fill(dialog);
  await userEvent.click(within(dialog).getByRole("button", { name: "검토한 프로필 삭제" }));
  await within(dialog).findByRole("button", { name: "최신 상태로 다시 검토" });
  denied = true;
  await userEvent.click(within(dialog).getByRole("button", { name: "최신 상태로 다시 검토" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.queryByDisplayValue("이전 설정 정리")).not.toBeInTheDocument();
  expect(view.api.bodies(action)).toHaveLength(1);
});
it("삭제 결과의 대상이 다르면 성공을 표시하지 않고 상태 확인을 요구한다", async () => {
  const success = vi.spyOn(toast, "success");
  const view = setup({
    [action]: () => ({
      virtual_model: "vibe/text2sql-other",
      reviewed_revision: row.revision,
      status: "deleted",
    }),
  });
  const dialog = await openDelete();
  await fill(dialog);
  await userEvent.click(within(dialog).getByRole("button", { name: "검토한 프로필 삭제" }));
  expect(await within(dialog).findByRole("button", { name: "최신 상태로 다시 검토" })).toBeVisible();
  expect(success).not.toHaveBeenCalled();
  expect(view.api.bodies(action)).toHaveLength(1);
});
it("삭제 사유를 입력한 뒤 닫을 때 초안 폐기를 확인한다", async () => {
  const view = setup();
  const dialog = await openDelete();
  await fill(dialog);
  await userEvent.click(within(dialog).getByRole("button", { name: "취소" }));
  await userEvent.click(await screen.findByRole("button", { name: "계속 편집" }));
  expect(within(dialog).getByLabelText(/삭제 사유/u)).toHaveValue("이전 설정 정리");
  await userEvent.click(within(dialog).getByRole("button", { name: "취소" }));
  await userEvent.click(await screen.findByRole("button", { name: "변경 버리기" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(view.api.bodies(action)).toEqual([]);
});
