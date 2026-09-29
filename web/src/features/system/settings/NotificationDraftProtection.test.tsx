import { useQuery } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deferred, notificationConfig, setupInline } from "@/features/system/settings/inline-settings-test";
import { NotificationForm } from "@/features/system/settings/NotificationForm";
import { systemSettingsKeys } from "@/features/system/settings/use-system-settings";
import type { NotificationConfig } from "@/shared/api/domains/system.schemas";
import { publishLogout } from "@/shared/auth/token-store";
import { apiFailure, mockApi } from "@/test/api";

afterEach(() => vi.restoreAllMocks());
const path = "POST /admin/notifications/mattermost";
const view = (config = notificationConfig, hasAdminWrite = true) => (
  <NotificationForm config={config} hasAdminWrite={hasAdminWrite} />
);
const input = () => screen.getByLabelText("채널");

describe("알림 인라인 초안 보호", () => {
  it("깨끗한 재조회는 반영하고 dirty 값은 유지하며 원복하면 최신 값으로 갱신한다", async () => {
    mockApi({});
    const user = userEvent.setup();
    const screenView = setupInline(view());
    screenView.rerender(view({ ...notificationConfig, channel: "clean-refresh" }));
    expect(input()).toHaveValue("clean-refresh");
    await user.type(input(), "-draft");
    screenView.rerender(view({ ...notificationConfig, channel: "concurrent" }));
    expect(input()).toHaveValue("clean-refresh-draft");
    expect(screen.getByText(/동시 편집 충돌을 자동으로 차단하지 않습니다/)).toBeVisible();
    await user.clear(input());
    await user.type(input(), "clean-refresh");
    expect(input()).toHaveValue("concurrent");
  });

  it("이벤트만 변경해도 dirty이고 원복은 깨끗하며 비밀 폐기는 확인 후 메모리에서 지운다", async () => {
    const api = mockApi({});
    const user = userEvent.setup();
    setupInline(view());
    await user.click(screen.getByLabelText("비밀정보 탐지"));
    await user.click(screen.getByRole("button", { name: "변경 취소" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "계속 편집" }),
    );
    expect(screen.getByLabelText("비밀정보 탐지")).toBeChecked();
    await user.click(screen.getByLabelText("비밀정보 탐지"));
    await user.click(screen.getByRole("button", { name: "변경 취소" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("웹훅 주소"), "https://hooks.example/synthetic-token");
    await user.click(screen.getByRole("button", { name: "변경 취소" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "변경 버리기" }),
    );
    expect(screen.getByLabelText("웹훅 주소")).toHaveValue("");
    expect(api.calls).toHaveLength(0);
    await user.type(input(), "-again");
    await user.click(screen.getByRole("button", { name: "변경 취소" }));
    expect(await screen.findByRole("alertdialog")).toBeVisible();
  });

  it.each(["keep", "replace", "clear"] as const)(
    "웹훅 %s와 명시 빈 이벤트 목록을 정확히 전송하고 비밀은 cache·storage·mutation에 보관하지 않는다",
    async (mode) => {
      const latest: NotificationConfig = {
        ...notificationConfig,
        events: [],
        webhook_url: mode === "clear" ? "" : "********",
        webhook_url_set: mode !== "clear",
      };
      const api = mockApi({ [path]: () => latest });
      const storage = vi.spyOn(Storage.prototype, "setItem");
      const user = userEvent.setup();
      const screenView = setupInline(view());
      const webhook = screen.getByLabelText("웹훅 주소");
      expect(webhook).toHaveValue("");
      if (mode === "replace") await user.type(webhook, "https://hooks.example/synthetic-token");
      if (mode === "clear") {
        await user.type(webhook, "discarded-secret");
        await user.click(screen.getByLabelText("저장된 웹훅 주소 지우기"));
        expect(webhook).toHaveValue("");
        expect(webhook).toBeDisabled();
      }
      await user.click(screen.getByLabelText("비용 경보"));
      await user.click(screen.getByRole("button", { name: "알림 설정 저장" }));
      await waitFor(() => expect(api.bodies(path)).toHaveLength(1));
      expect(api.bodies(path)[0]).toEqual({
        enabled: true,
        channel: "operations",
        events: [],
        ...(mode === "keep"
          ? {}
          : { webhook_url: mode === "clear" ? "" : "https://hooks.example/synthetic-token" }),
      });
      expect(webhook).toHaveValue("");
      expect(webhook).toBeEnabled();
      expect(screen.getByLabelText("비용 경보")).not.toBeChecked();
      expect(JSON.stringify(screenView.client.getQueryData(systemSettingsKeys.notifications))).not.toContain(
        "synthetic-token",
      );
      expect(screenView.client.getMutationCache().getAll()).toHaveLength(0);
      expect(storage).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "변경 취소" }));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      await user.type(input(), "-next");
      await user.click(screen.getByRole("button", { name: "변경 취소" }));
      expect(await screen.findByRole("alertdialog")).toBeVisible();
    },
  );

  it.each(["********", "   "])(
    "마스킹/공백 주소 %j는 잘못된 비밀 교체나 삭제로 전송하지 않는다",
    async (value) => {
      const api = mockApi({});
      const user = userEvent.setup();
      setupInline(view());
      await user.type(screen.getByLabelText("웹훅 주소"), value);
      await user.click(screen.getByRole("button", { name: "알림 설정 저장" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("마스킹된 주소나 공백");
      expect(api.calls).toHaveLength(0);
    },
  );

  it("pending은 입력·스위치·이벤트·취소를 잠그고 중복 submit 및 미전송 편집을 차단한다", async () => {
    const pending = deferred<NotificationConfig>();
    const api = mockApi({ [path]: () => pending.promise });
    const user = userEvent.setup();
    const screenView = setupInline(view());
    await user.type(input(), "-draft");
    await user.type(screen.getByLabelText("웹훅 주소"), "https://hooks.example/synthetic-token");
    const form = input().closest("form");
    if (!form) throw new Error("form missing");
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await waitFor(() => expect(api.bodies(path)).toHaveLength(1));
    expect(input()).toBeDisabled();
    expect(screen.getByRole("switch", { name: "알림 사용" })).toBeDisabled();
    expect(screen.getByLabelText("비용 경보")).toBeDisabled();
    expect(screen.getByRole("button", { name: "변경 취소" })).toBeDisabled();
    await user.type(input(), "-lost");
    await user.click(screen.getByLabelText("비용 경보"));
    expect(input()).toHaveValue("operations-draft");
    screenView.rerender(view({ ...notificationConfig, channel: "concurrent" }));
    expect(input()).toHaveValue("operations-draft");
    await act(async () => pending.resolve({ ...notificationConfig, channel: "operations-draft" }));
    expect(input()).toBeEnabled();
    expect(input()).toHaveValue("operations-draft");
    expect(screen.getByLabelText("웹훅 주소")).toHaveValue("");
    expect(api.bodies(path)[0]).toMatchObject({ channel: "operations-draft", events: ["cost"] });
  });

  it("저장 실패는 초안·비밀을 유지하고 다시 편집할 수 있다", async () => {
    mockApi({
      [path]: () => {
        throw apiFailure("server unavailable");
      },
    });
    const user = userEvent.setup();
    setupInline(view());
    await user.type(screen.getByLabelText("웹훅 주소"), "https://hooks.example/synthetic-token");
    await user.click(screen.getByRole("button", { name: "알림 설정 저장" }));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(input()).toBeEnabled();
    expect(screen.getByLabelText("웹훅 주소")).toHaveValue("https://hooks.example/synthetic-token");
    await user.type(input(), "-retry");
    expect(input()).toHaveValue("operations-retry");
  });

  it("저장 전에 시작한 늦은 조회는 수락한 저장 snapshot과 cache를 덮지 않는다", async () => {
    const oldRead = deferred<NotificationConfig>();
    const latest = { ...notificationConfig, channel: "accepted" };
    mockApi({ [path]: () => latest });
    function LiveForm() {
      const query = useQuery({
        queryKey: systemSettingsKeys.notifications,
        initialData: notificationConfig,
        staleTime: Infinity,
        queryFn: () => oldRead.promise,
      });
      return view(query.data);
    }
    const user = userEvent.setup();
    const { client } = setupInline(<LiveForm />);
    await user.type(input(), "-draft");
    let read!: Promise<void>;
    act(() => {
      read = client.refetchQueries({ queryKey: systemSettingsKeys.notifications });
    });
    await user.click(screen.getByRole("button", { name: "알림 설정 저장" }));
    await waitFor(() => expect(input()).toHaveValue("accepted"));
    await act(async () => {
      oldRead.resolve(notificationConfig);
      await read;
    });
    expect(input()).toHaveValue("accepted");
    expect(client.getQueryData(systemSettingsKeys.notifications)).toMatchObject({ channel: "accepted" });
  });

  it.each(["resolve", "reject"] as const)(
    "로그아웃 후 늦은 %s는 비밀·캐시·새 초안·toast를 복구하지 않는다",
    async (outcome) => {
      const pending = deferred<NotificationConfig>();
      const saved = vi.spyOn(toast, "success").mockImplementation(() => "toast");
      mockApi({ [path]: () => pending.promise });
      const user = userEvent.setup();
      const { client } = setupInline(view());
      await user.type(screen.getByLabelText("웹훅 주소"), "https://hooks.example/synthetic-token");
      await user.click(screen.getByRole("button", { name: "알림 설정 저장" }));
      act(() => publishLogout());
      expect(screen.getByLabelText("웹훅 주소")).toHaveValue("");
      expect(input()).toBeDisabled();
      await act(async () =>
        outcome === "resolve"
          ? pending.resolve({ ...notificationConfig, channel: "old-result" })
          : pending.reject(apiFailure("old-error")),
      );
      await waitFor(() => expect(input()).toBeEnabled());
      await user.type(input(), "-fresh");
      expect(input()).toHaveValue("operations-fresh");
      expect(client.getQueryData(systemSettingsKeys.notifications)).toBeUndefined();
      expect(saved).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("읽기 권한은 저장·비밀·입력·초기화 작업을 활성화하지 않는다", () => {
    const api = mockApi({});
    setupInline(view(notificationConfig, false));
    expect(input()).toBeDisabled();
    expect(screen.getByLabelText("웹훅 주소")).toBeDisabled();
    expect(screen.getByRole("button", { name: "알림 설정 저장" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "변경 취소" })).toBeDisabled();
    expect(api.calls).toHaveLength(0);
  });
});
