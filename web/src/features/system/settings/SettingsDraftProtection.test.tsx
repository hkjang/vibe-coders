import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useRef, useState, type PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";

import { ConsoleFeatureDialog } from "@/features/system/settings/ConsoleFeatureDialog";
import { SettingDetailSheet, type SettingSaveInput } from "@/features/system/settings/SettingDetailSheet";
import type { EffectiveSetting } from "@/shared/api/domains/system.schemas";
import { publishLogout } from "@/shared/auth/token-store";
import { UnsavedChangesContext } from "@/shared/unsaved/context";
import { UnsavedChangesCoordinator } from "@/shared/unsaved/coordinator";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";
import { apiFailure, mockApi } from "@/test/api";

const setting: EffectiveSetting = {
  key: "clickhouse.url",
  category: "clickhouse",
  type: "string",
  description: "접속 주소",
  is_secret: false,
  is_set: true,
  read_only: false,
  restart_required: false,
  source: "admin",
  effective_source: "db_setting",
  value: "http://old:8123",
  can_write: true,
  version: 3,
};

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

function Harness({
  mode = "detail",
  current = setting,
  save = async () => undefined,
  recovery = () => undefined,
}: {
  mode?: "detail" | "feature";
  current?: EffectiveSetting;
  save?: (input: SettingSaveInput) => Promise<unknown>;
  recovery?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={trigger} onClick={() => setOpen(true)}>
        편집 열기
      </button>
      {mode === "detail" ? (
        <SettingDetailSheet
          open={open}
          onOpenChange={setOpen}
          setting={current}
          hasAdminWrite
          pending={false}
          returnFocusRef={trigger}
          onSave={save}
          onRequestRevert={recovery}
          onRequestRollback={recovery}
        />
      ) : (
        <ConsoleFeatureDialog
          open={open}
          onOpenChange={setOpen}
          row={{ featureId: "system.settings", status: { ...current, value: "legacy" } }}
          title="전환 설정"
          disabledReason={undefined}
          pending={false}
          returnFocusRef={trigger}
          onSubmit={(input) =>
            save({
              setting: input.row.status ?? current,
              value: input.changes.status ?? "legacy",
              reason: input.reason,
            })
          }
        />
      )}
    </>
  );
}

function setup(ui: React.ReactNode) {
  mockApi({
    "GET /admin/settings/history": () => ({
      history: [
        {
          id: "history-3",
          key: setting.key,
          old_value_json: "old",
          new_value_json: "current",
          history_count: 1,
        },
      ],
    }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: PropsWithChildren) => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <UnsavedChangesProvider>{children}</UnsavedChangesProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  return render(ui, { wrapper });
}

describe.each(["detail", "feature"] as const)("%s 설정 초안 보호", (mode) => {
  it("사유만 변경해도 경고하고 계속 편집 포커스·원복·폐기를 보존한다", async () => {
    const user = userEvent.setup();
    setup(<Harness mode={mode} />);
    const trigger = screen.getByRole("button", { name: "편집 열기" });
    await user.click(trigger);
    const reason = screen.getByRole("textbox", { name: "변경 사유" });
    await user.type(reason, "입력한 사유");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await user.keyboard("{Escape}");
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "계속 편집" }),
    );
    expect(reason).toHaveFocus();
    expect(reason).toHaveValue("입력한 사유");
    await user.clear(reason);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.click(trigger);
    await user.type(screen.getByRole("textbox", { name: "변경 사유" }), "버릴 사유");
    await user.keyboard("{Escape}");
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "변경 버리기" }),
    );
    await user.click(trigger);
    expect(screen.getByRole("textbox", { name: "변경 사유" })).toHaveValue("");
  });

  it.each(["success", "failure"])("저장 중 입력·중복 저장·폐기를 잠그고 %s를 처리한다", async (outcome) => {
    const user = userEvent.setup();
    const response = deferred();
    const save = vi.fn((_input: SettingSaveInput) => {
      void _input;
      return response.promise;
    });
    setup(<Harness mode={mode} save={save} />);
    await user.click(screen.getByRole("button", { name: "편집 열기" }));
    const value =
      mode === "detail"
        ? screen.getByRole("textbox", { name: "새 값" })
        : screen.getByRole("combobox", { name: "전환 상태" });
    if (mode === "detail") {
      await user.clear(value);
      await user.type(value, "http://draft:8123");
    } else await user.selectOptions(value, "preview");
    await user.type(screen.getByRole("textbox", { name: "변경 사유" }), "검토 완료");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      setting: { version: 3 },
      value: mode === "detail" ? "http://draft:8123" : "preview",
      reason: "검토 완료",
    });
    expect(value).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "변경 사유" })).toBeDisabled();
    if (mode === "detail") expect(screen.getByRole("button", { name: "이전 값으로 롤백" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "저장 중" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(save).toHaveBeenCalledOnce();
    await act(async () => {
      if (outcome === "success") response.resolve();
      else response.reject(apiFailure("failed", 500, "req-setting"));
    });
    if (outcome === "success") {
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    } else {
      expect(await screen.findByRole("alert")).toHaveTextContent("req-setting");
      expect(value).toBeEnabled();
      expect(value).toHaveValue(mode === "detail" ? "http://draft:8123" : "preview");
      await user.keyboard("{Escape}");
      expect(await screen.findByRole("alertdialog")).toBeVisible();
    }
  });

  it.each(["success", "failure"])(
    "보안 폐기 뒤 이전 %s 응답은 새 편집기를 바꾸지 않는다",
    async (outcome) => {
      const user = userEvent.setup();
      const response = deferred();
      setup(<Harness mode={mode} save={() => response.promise} />);
      await user.click(screen.getByRole("button", { name: "편집 열기" }));
      if (mode === "detail") await user.type(screen.getByRole("textbox", { name: "새 값" }), "/old-draft");
      else await user.selectOptions(screen.getByRole("combobox", { name: "전환 상태" }), "preview");
      await user.click(screen.getByRole("button", { name: "저장" }));
      act(() => publishLogout());
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "편집 열기" }));
      await user.type(screen.getByRole("textbox", { name: "변경 사유" }), "새 초안");
      await act(async () => {
        if (outcome === "success") response.resolve();
        else response.reject(apiFailure("old failure"));
      });
      expect(screen.getByRole("textbox", { name: "변경 사유" })).toHaveValue("새 초안");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await user.keyboard("{Escape}");
      expect(await screen.findByRole("alertdialog")).toBeVisible();
    },
  );
});

describe("설정 snapshot과 복구 전환", () => {
  it("같은 key의 새 prop가 도착해도 열린 값과 CAS 버전을 함께 고정한다", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async (input: SettingSaveInput) => {
      void input;
    });
    const view = setup(<Harness save={save} />);
    await user.click(screen.getByRole("button", { name: "편집 열기" }));
    const value = screen.getByRole("textbox", { name: "새 값" });
    await user.clear(value);
    await user.type(value, "http://draft:8123");
    view.rerender(<Harness save={save} current={{ ...setting, value: "http://remote:8123", version: 4 }} />);
    expect(value).toHaveValue("http://draft:8123");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ setting, value: "http://draft:8123", reason: "" }),
    );
  });

  it("비밀값은 빈 입력에서 시작하고 폐기·재열기 때 지우며 저장소에 쓰지 않는다", async () => {
    const user = userEvent.setup();
    const storage = vi.spyOn(Storage.prototype, "setItem");
    setup(<Harness current={{ ...setting, is_secret: true, value: "masked" }} />);
    await user.click(screen.getByRole("button", { name: "편집 열기" }));
    expect(screen.getByLabelText("새 비밀값")).toHaveValue("");
    await user.type(screen.getByLabelText("새 비밀값"), "new-test-secret");
    await user.keyboard("{Escape}");
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "변경 버리기" }),
    );
    await user.click(screen.getByRole("button", { name: "편집 열기" }));
    expect(screen.getByLabelText("새 비밀값")).toHaveValue("");
    expect(screen.getByRole("button", { name: "이전 값으로 롤백" })).toBeDisabled();
    expect(
      storage.mock.calls.some((call) => call.some((value) => String(value).includes("new-test-secret"))),
    ).toBe(false);
  });

  it.each(["기본값(환경변수)으로 되돌리기", "이전 값으로 롤백"])(
    "%s 전환은 명시적 로컬 폐기 때만 진행한다",
    async (label) => {
      const user = userEvent.setup();
      const recovery = vi.fn();
      setup(<Harness recovery={recovery} />);
      await user.click(screen.getByRole("button", { name: "편집 열기" }));
      await user.type(screen.getByRole("textbox", { name: "변경 사유" }), "초안");
      await user.click(screen.getByRole("button", { name: label }));
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "계속 편집" }),
      );
      expect(recovery).not.toHaveBeenCalled();
      expect(screen.getByRole("textbox", { name: "변경 사유" })).toHaveValue("초안");
      expect(screen.getByRole("button", { name: label })).toHaveFocus();
      await user.click(screen.getByRole("button", { name: label }));
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "변경 버리기" }),
      );
      expect(recovery).toHaveBeenCalledOnce();
    },
  );

  it("보안 폐기는 대기 중인 복구 전환을 실행하지 않는다", async () => {
    const user = userEvent.setup();
    const recovery = vi.fn();
    setup(<Harness recovery={recovery} />);
    await user.click(screen.getByRole("button", { name: "편집 열기" }));
    await user.type(screen.getByRole("textbox", { name: "변경 사유" }), "초안");
    await user.click(screen.getByRole("button", { name: "이전 값으로 롤백" }));
    expect(await screen.findByRole("alertdialog")).toBeVisible();
    act(() => publishLogout());
    expect(recovery).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("경로 폐기는 보류한 로컬 복구 콜백을 실행하지 않는다", async () => {
    const user = userEvent.setup();
    const coordinator = new UnsavedChangesCoordinator();
    const recovery = vi.fn();
    const proceed = vi.fn();
    setup(
      <UnsavedChangesContext.Provider value={coordinator}>
        <Harness recovery={recovery} />
      </UnsavedChangesContext.Provider>,
    );
    await user.click(screen.getByRole("button", { name: "편집 열기" }));
    await user.type(screen.getByRole("textbox", { name: "변경 사유" }), "초안");
    await user.click(screen.getByRole("button", { name: "이전 값으로 롤백" }));
    act(() => {
      coordinator.requestNavigation({ proceed, reset: vi.fn() });
      coordinator.discardConfirmed();
    });
    expect(proceed).toHaveBeenCalledOnce();
    expect(recovery).not.toHaveBeenCalled();
    expect(coordinator.shouldBlock()).toBe(false);
  });
});
