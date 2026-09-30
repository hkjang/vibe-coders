import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { publishLogout, tokenStore } from "@/shared/auth/token-store";
import { apiFailure } from "@/test/api";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth() };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
beforeEach(() => tokenStore.clearAll());

describe("앱 추가 접근 권한 초안 수명", () => {
  it.each(["취소", "Escape", "대화상자 닫기"])(
    "%s 닫기에서 계속 편집과 폐기를 구분하고 열기 버튼에 복귀한다",
    async (method) => {
      const user = userEvent.setup();
      const { api } = setup();
      const dialog = await openGrant(user);
      await fillGrant(user, dialog);
      if (method === "Escape") await user.keyboard("{Escape}");
      else await user.click(within(dialog).getByRole("button", { name: method }));
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "계속 편집" }),
      );
      expect(within(dialog).getByRole("textbox")).toHaveValue("user_two");
      const unload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(true);
      await user.click(within(dialog).getByRole("button", { name: "취소" }));
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "변경 버리기" }),
      );
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "앱 접근 권한 추가" })).not.toBeInTheDocument(),
      );
      expect(screen.getByRole("button", { name: "접근 권한 추가" })).toHaveFocus();
      expect(api.bodies(`POST ${path}`)).toEqual([]);
      const cleanUnload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(cleanUnload);
      expect(cleanUnload.defaultPrevented).toBe(false);
    },
  );

  it.each(["패널 닫기", "권한 관리"])(
    "상위 %s 의 폐기 전까지 폼을 유지하고 계속 편집 뒤의 취소는 상위를 닫지 않는다",
    async (label) => {
      const user = userEvent.setup();
      setup();
      const dialog = await openGrant(user);
      await fillGrant(user, dialog);
      const parentButton = label === "패널 닫기" ? screen.getByLabelText(label) : screen.getByText(label);
      fireEvent.click(parentButton);
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "계속 편집" }),
      );
      expect(dialog).toBeVisible();
      await user.click(within(dialog).getByRole("button", { name: "취소" }));
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "변경 버리기" }),
      );
      expect(screen.getByRole("button", { name: "접근 권한 추가" })).toBeVisible();
      await user.click(screen.getByRole("button", { name: "접근 권한 추가" }));
      const next = await screen.findByRole("dialog", { name: "앱 접근 권한 추가" });
      await fillGrant(user, next);
      fireEvent.click(parentButton);
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "변경 버리기" }),
      );
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "앱 접근 권한 추가" })).not.toBeInTheDocument(),
      );
      expect(screen.queryByRole("button", { name: "접근 권한 추가" })).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: label === "패널 닫기" ? "상세 열기" : "권한 관리" }),
      ).toHaveFocus();
    },
  );

  it("원래 빈 값으로 돌리면 폐기 확인 없이 닫힌다", async () => {
    const user = userEvent.setup();
    setup();
    const dialog = await openGrant(user);
    await fillGrant(user, dialog);
    await user.clear(within(dialog).getByRole("textbox"));
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "앱 접근 권한 추가" })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("회수는 고정 대상 확인만 열며 확인 전에는 DELETE가 없다", async () => {
    const user = userEvent.setup();
    const { api, client } = setup();
    await openPanel(user);
    await user.click(await screen.findByRole("button", { name: "user_one 권한 회수" }));
    const dialog = await screen.findByRole("dialog", { name: "앱 추가 접근 권한 회수" });
    expect(dialog).toHaveTextContent("전체 접근을 금지하는 작업이 아닙니다");
    expect(dialog).toHaveTextContent("user_one");
    expect(api.calls.filter(({ key }) => key.startsWith("DELETE"))).toEqual([]);
    act(() => client.setQueryData(permissionKey, { permissions: [{ ...row, subject_id: "other" }] }));
    fireEvent.click(screen.getByText("외부 앱 변경"));
    await user.click(within(dialog).getByRole("button", { name: "권한 회수" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "앱 추가 접근 권한 회수" })).not.toBeInTheDocument(),
    );
    expect(api.calls.filter(({ key }) => key.startsWith("DELETE"))).toEqual([
      {
        key: `DELETE ${path}`,
        options: { body: undefined, query: { subject_type: "user", subject_id: "user_one" } },
      },
    ]);
  });

  it("회수 취소는 요청 없이 같은 행으로 포커스를 복원한다", async () => {
    const user = userEvent.setup();
    const { api, client } = setup();
    await openPanel(user);
    await user.click(await screen.findByRole("button", { name: "user_one 권한 회수" }));
    const dialog = await screen.findByRole("dialog", { name: "앱 추가 접근 권한 회수" });
    act(() => client.setQueryData(permissionKey, { permissions: [{ ...row, id: "refetched_row" }] }));
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "user_one 권한 회수" })).toHaveFocus());
    expect(api.calls.filter(({ key }) => key.startsWith("DELETE"))).toEqual([]);
  });

  it("회수 실패는 요청 ID와 대상을 남기고 한 번씩 수동 재시도한다", async () => {
    const user = userEvent.setup();
    const held = deferred();
    let retry = false;
    const { api } = setup({
      revoke: () => {
        if (!retry) return held.promise;
        return {};
      },
    });
    await openPanel(user);
    await user.click(await screen.findByRole("button", { name: "user_one 권한 회수" }));
    const dialog = await screen.findByRole("dialog", { name: "앱 추가 접근 권한 회수" });
    fireEvent.submit(dialogForm(dialog));
    fireEvent.submit(dialogForm(dialog));
    await waitFor(() => expect(api.calls.filter(({ key }) => key.startsWith("DELETE"))).toHaveLength(1));
    expect(within(dialog).getByRole("button", { name: "취소" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(dialog).toBeVisible();
    await act(async () => held.reject(apiFailure("unavailable", 503, "req_revoke")));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("req_revoke");
    expect(dialog).toHaveTextContent("user_one");
    retry = true;
    await user.click(within(dialog).getByRole("button", { name: "권한 회수" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "앱 추가 접근 권한 회수" })).not.toBeInTheDocument(),
    );
    expect(
      api.calls.filter(({ key }) => key.startsWith("DELETE")).map(({ options }) => options.query),
    ).toEqual(Array(2).fill({ subject_type: "user", subject_id: "user_one" }));
  });

  it("회수 확인 도중 권한 상실은 직접 제출을 막는다", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await openPanel(user);
    await user.click(await screen.findByRole("button", { name: "user_one 권한 회수" }));
    const dialog = await screen.findByRole("dialog", { name: "앱 추가 접근 권한 회수" });
    fireEvent.click(screen.getByText("쓰기 권한 제거"));
    expect(within(dialog).getByRole("button", { name: "권한 회수" })).toBeDisabled();
    fireEvent.submit(dialogForm(dialog));
    await act(async () => undefined);
    expect(api.calls.filter(({ key }) => key.startsWith("DELETE"))).toEqual([]);
  });

  it.each(["grant", "revoke"])(
    "%s 의 보안 로그아웃은 pending이어도 닫고 뒤늦은 성공이 새 초안·캐시·알림을 변경하지 않는다",
    async (kind) => {
      const held = deferred();
      const user = userEvent.setup();
      const { api } = setup({ [kind]: () => held.promise });
      let dialog: HTMLElement;
      if (kind === "grant") {
        dialog = await openGrant(user);
        await fillGrant(user, dialog, "old_subject");
      } else {
        await openPanel(user);
        await user.click(await screen.findByRole("button", { name: "user_one 권한 회수" }));
        dialog = await screen.findByRole("dialog", { name: "앱 추가 접근 권한 회수" });
      }
      fireEvent.submit(dialogForm(dialog));
      await waitFor(() => expect(api.calls.filter(({ key }) => !key.startsWith("GET"))).toHaveLength(1));
      act(() => publishLogout());
      await waitFor(() => expect(dialog).not.toBeInTheDocument());
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      act(() => tokenStore.saveTokens({ access_token: "synthetic-new", refresh_token: "synthetic-refresh" }));
      await user.click(screen.getByRole("button", { name: "접근 권한 추가" }));
      const current = await screen.findByRole("dialog", { name: "앱 접근 권한 추가" });
      await fillGrant(user, current, "current_subject");
      const reads = api.calls.filter(({ key }) => key.startsWith("GET")).length;
      await act(async () => held.resolve({}));
      expect(within(current).getByRole("textbox")).toHaveValue("current_subject");
      expect(within(current).getByRole("button", { name: "접근 권한 추가" })).toBeEnabled();
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      expect(api.calls.filter(({ key }) => key.startsWith("GET"))).toHaveLength(reads);
      expect(within(current).queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("세션만 바뀌어도 초안을 버리고 이전 실패를 새 편집에 표시하지 않는다", async () => {
    const held = deferred();
    const user = userEvent.setup();
    const { api } = setup({ grant: () => held.promise });
    const dialog = await openGrant(user);
    await fillGrant(user, dialog);
    fireEvent.submit(dialogForm(dialog));
    await waitFor(() => expect(api.bodies(`POST ${path}`)).toHaveLength(1));
    act(() => tokenStore.saveTokens({ access_token: "synthetic-new", refresh_token: "synthetic-refresh" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "접근 권한 추가" }));
    const current = await screen.findByRole("dialog", { name: "앱 접근 권한 추가" });
    expect(within(current).getByRole("textbox")).toHaveValue("");
    await act(async () => held.reject(apiFailure("old failure", 503, "old_req")));
    expect(within(current).queryByRole("alert")).not.toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("이전 요청 완료가 새 세션의 진행 중인 제출을 풀거나 닫지 않는다", async () => {
    const previous = deferred();
    const current = deferred();
    let count = 0;
    const user = userEvent.setup();
    const { api } = setup({ grant: () => (++count === 1 ? previous.promise : current.promise) });
    const oldDialog = await openGrant(user);
    await fillGrant(user, oldDialog, "old_subject");
    fireEvent.submit(dialogForm(oldDialog));
    await waitFor(() => expect(api.bodies(`POST ${path}`)).toHaveLength(1));
    act(() => tokenStore.saveTokens({ access_token: "synthetic-new", refresh_token: "synthetic-refresh" }));
    await user.click(await screen.findByRole("button", { name: "접근 권한 추가" }));
    const newDialog = await screen.findByRole("dialog", { name: "앱 접근 권한 추가" });
    await fillGrant(user, newDialog, "current_subject");
    fireEvent.submit(dialogForm(newDialog));
    await waitFor(() => expect(api.bodies(`POST ${path}`)).toHaveLength(2));
    const reads = api.calls.filter(({ key }) => key.startsWith("GET")).length;
    await act(async () => previous.resolve({}));
    expect(newDialog).toBeVisible();
    expect(within(newDialog).getByRole("textbox")).toBeDisabled();
    expect(within(newDialog).getByRole("textbox")).toHaveValue("current_subject");
    expect(within(newDialog).getByRole("button", { name: "저장 중" })).toBeDisabled();
    fireEvent.submit(dialogForm(newDialog));
    expect(api.bodies(`POST ${path}`)).toHaveLength(2);
    expect(api.calls.filter(({ key }) => key.startsWith("GET"))).toHaveLength(reads);
    expect(toast.success).not.toHaveBeenCalled();
    await act(async () => current.resolve({}));
    await waitFor(() => expect(newDialog).not.toBeInTheDocument());
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});
