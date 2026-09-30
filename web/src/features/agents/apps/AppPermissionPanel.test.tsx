import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { appPermissionTarget } from "./app-permission-form";
import {
  deferred,
  dialogForm,
  fillGrant,
  openGrant,
  openPanel,
  path,
  permissionKey,
  row,
  setup,
} from "./app-permission-test-support";
import { tokenStore } from "@/shared/auth/token-store";
import { apiFailure } from "@/test/api";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth() };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
beforeEach(() => tokenStore.clearAll());

describe("앱 추가 접근 권한", () => {
  it("기존 팀·역할 조건을 대체하지 않고 활성 앱에 적용된다는 안내를 표시한다", async () => {
    const user = userEvent.setup();
    setup({ load: () => ({ permissions: [] }) });
    await openPanel(user);
    expect(await screen.findByText("추가 접근 권한이 없습니다.")).toBeVisible();
    expect(screen.getByText(/활성 앱에서 기존 팀·역할/)).toBeVisible();
    expect(screen.queryByText(/특정 사용자나 팀에게만/)).not.toBeInTheDocument();
  });

  it("조회 실패를 빈 목록으로 표시하지 않고 요청 ID와 수동 재시도를 제공한다", async () => {
    let failing = true;
    const user = userEvent.setup();
    setup({
      load: () => {
        if (failing) throw apiFailure("unavailable", 503, "req_permission_list");
        return { permissions: [] };
      },
    });
    await openPanel(user);
    expect(await screen.findByText(/요청 ID: req_permission_list/)).toBeVisible();
    expect(screen.queryByText("추가 접근 권한이 없습니다.")).not.toBeInTheDocument();
    failing = false;
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("추가 접근 권한이 없습니다.")).toBeVisible();
  });

  it("재조회 실패에서도 이전 행을 현재 목록처럼 표시하지 않는다", async () => {
    let failing = false;
    const user = userEvent.setup();
    setup({
      load: () => {
        if (failing) throw apiFailure("unavailable");
        return { permissions: [row] };
      },
    });
    await openPanel(user);
    expect(await screen.findByRole("table")).toBeVisible();
    failing = true;
    await user.click(screen.getByRole("button", { name: "권한 목록 새로고침" }));
    expect(await screen.findByText(/요청 ID:/)).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("알 수 없는 종류와 빈 ID를 사용자로 바꾸어 회수하지 않는다", async () => {
    const user = userEvent.setup();
    const { api } = setup({
      load: () => ({
        permissions: [
          { ...row, id: "unknown", subject_type: "organization" },
          { ...row, id: "missing", subject_type: null, subject_id: "user_missing" },
          { ...row, id: "blank", subject_id: " " },
        ],
      }),
    });
    await openPanel(user);
    expect(await screen.findByText("알 수 없는 종류 (organization)")).toBeVisible();
    for (const button of screen.getAllByRole("button", { name: /권한 회수/ })) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(screen.queryByRole("dialog", { name: "앱 추가 접근 권한 회수" })).not.toBeInTheDocument();
    expect(api.calls.filter(({ key }) => key.startsWith("DELETE"))).toEqual([]);
    expect(appPermissionTarget({ ...row, subject_type: "USER" })).toBeUndefined();
  });

  it("읽기 전용은 추가와 회수를 열지 않고 요청하지 않는다", async () => {
    const user = userEvent.setup();
    const { api } = setup({ writable: false });
    const add = await openPanel(user);
    const revoke = await screen.findByRole("button", { name: "user_one 권한 회수" });
    for (const button of [add, revoke]) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(screen.queryByRole("dialog", { name: "앱 접근 권한 추가" })).not.toBeInTheDocument();
    expect(api.calls.filter(({ key }) => !key.startsWith("GET"))).toEqual([]);
  });

  it("빈 ID를 거부하고 팀 ID의 공백만 정리해 정확한 POST를 보낸다", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    const dialog = await openGrant(user);
    await user.click(within(dialog).getByRole("button", { name: "접근 권한 추가" }));
    expect(await within(dialog).findByText("대상 ID를 입력하세요.")).toBeVisible();
    expect(api.bodies(`POST ${path}`)).toEqual([]);
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "대상 종류" }), "team");
    await user.type(within(dialog).getByRole("textbox", { name: "팀 ID" }), "  opaque/team ID  ");
    await user.click(within(dialog).getByRole("button", { name: "접근 권한 추가" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "앱 접근 권한 추가" })).not.toBeInTheDocument(),
    );
    expect(api.bodies(`POST ${path}`)).toEqual([{ subject_type: "team", subject_id: "opaque/team ID" }]);
    expect(screen.getByRole("button", { name: "접근 권한 추가" })).toHaveFocus();
  });

  it("목록 갱신과 외부 앱 변경이 열린 앱·초안을 바꾸지 않는다", async () => {
    const user = userEvent.setup();
    const { api, client } = setup();
    const dialog = await openGrant(user);
    await fillGrant(user, dialog);
    act(() => client.setQueryData(permissionKey, { permissions: [{ ...row, subject_id: "changed" }] }));
    fireEvent.click(screen.getByText("외부 앱 변경"));
    expect(dialog).toHaveTextContent("검토 도우미");
    expect(dialog).toHaveTextContent("app_review");
    expect(within(dialog).getByRole("textbox")).toHaveValue("user_two");
    await user.click(within(dialog).getByRole("button", { name: "접근 권한 추가" }));
    await waitFor(() => expect(api.bodies(`POST ${path}`)).toHaveLength(1));
    expect(api.calls.some(({ key }) => key === "POST /admin/apps/other_app/permissions")).toBe(false);
  });

  it("오류와 요청 ID를 인라인에 남기고 같은 입력을 수동 재시도한다", async () => {
    let failing = true;
    const user = userEvent.setup();
    const { api } = setup({
      grant: () => {
        if (failing) throw apiFailure("unavailable", 503, "req_permission_save");
        return {};
      },
    });
    const dialog = await openGrant(user);
    await fillGrant(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "접근 권한 추가" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("req_permission_save");
    expect(within(dialog).getByRole("textbox")).toHaveValue("user_two");
    expect(api.bodies(`POST ${path}`)).toHaveLength(1);
    failing = false;
    await user.click(within(dialog).getByRole("button", { name: "접근 권한 추가" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "앱 접근 권한 추가" })).not.toBeInTheDocument(),
    );
    expect(api.bodies(`POST ${path}`)).toEqual(
      Array(2).fill({ subject_type: "user", subject_id: "user_two" }),
    );
  });

  it("열린 폼의 쓰기 권한 상실은 입력·버튼과 직접 제출 모두 막는다", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    const dialog = await openGrant(user);
    await fillGrant(user, dialog);
    fireEvent.click(screen.getByText("쓰기 권한 제거"));
    expect(within(dialog).getByRole("textbox")).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "접근 권한 추가" })).toBeDisabled();
    fireEvent.submit(dialogForm(dialog));
    await act(async () => undefined);
    expect(api.bodies(`POST ${path}`)).toEqual([]);
  });

  it("저장 중 모든 입력과 부모 동작을 잠그고 동기 중복 제출을 하나로 제한한다", async () => {
    const held = deferred();
    const user = userEvent.setup();
    const { api } = setup({ grant: () => held.promise });
    const dialog = await openGrant(user);
    await fillGrant(user, dialog);
    fireEvent.submit(dialogForm(dialog));
    fireEvent.submit(dialogForm(dialog));
    await waitFor(() => expect(api.bodies(`POST ${path}`)).toHaveLength(1));
    expect(within(dialog).getByRole("textbox")).toBeDisabled();
    expect(within(dialog).getByRole("combobox")).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "취소" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("패널 닫기"));
    fireEvent.click(screen.getByText("권한 관리"));
    await user.keyboard("{Escape}");
    expect(dialog).toBeVisible();
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await act(async () => held.resolve({}));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "앱 접근 권한 추가" })).not.toBeInTheDocument(),
    );
    expect(api.bodies(`POST ${path}`)).toEqual([{ subject_type: "user", subject_id: "user_two" }]);
  });
});
