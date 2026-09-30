import { useQuery } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deferred,
  roleOptions,
  setupInline,
  ssoConfig,
} from "@/features/system/settings/inline-settings-test";
import { SsoConfigForm } from "@/features/system/settings/SsoConfigForm";
import { systemSettingsKeys } from "@/features/system/settings/use-system-settings";
import type { KeycloakConfig } from "@/shared/api/domains/system.schemas";
import { AppError } from "@/shared/api/error";
import { publishLogout } from "@/shared/auth/token-store";
import { apiFailure, mockApi } from "@/test/api";

afterEach(() => vi.restoreAllMocks());
const path = "PUT /admin/sso/keycloak/config";
const view = (config = ssoConfig, hasAdminWrite = true) => (
  <SsoConfigForm config={config} hasAdminWrite={hasAdminWrite} roleOptions={roleOptions} />
);
const input = () => screen.getByLabelText("클라이언트 ID");
async function confirmSave(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "SSO 설정 저장" }));
  return within(await screen.findByRole("dialog", { name: "SSO 설정 저장" }));
}

describe("SSO 인라인 초안 보호", () => {
  it("깨끗한 재조회만 반영하고 dirty·원복·단순 동일 데이터 재조회를 구분한다", async () => {
    mockApi({});
    const user = userEvent.setup();
    const screenView = setupInline(view());
    screenView.rerender(view({ ...ssoConfig, client_id: "server-new", version: 5 }));
    expect(input()).toHaveValue("server-new");
    await user.type(input(), "-draft");
    const latest = { ...ssoConfig, client_id: "server-latest", version: 6 };
    screenView.rerender(view(latest));
    expect(input()).toHaveValue("server-new-draft");
    expect(screen.getByText("서버의 SSO 설정이 변경되었습니다.")).toBeVisible();
    screenView.rerender(view({ ...latest }));
    expect(input()).toHaveValue("server-new-draft");
    await user.clear(input());
    await user.type(input(), "server-new");
    expect(input()).toHaveValue("server-latest");
    const beforeUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(false);
  });

  it("비밀·역할 매핑 초안의 취소는 확인하고 계속 편집하면 값과 포커스를 보존한다", async () => {
    const api = mockApi({ "GET /admin/sso/keycloak/config": () => ssoConfig });
    const user = userEvent.setup();
    setupInline(view());
    await user.type(screen.getByLabelText("클라이언트 비밀키"), "synthetic-secret");
    await user.click(screen.getByRole("button", { name: "행 추가" }));
    await user.type(screen.getByLabelText("2번 Keycloak 역할"), "new-role");
    const reset = screen.getByRole("button", { name: "변경 취소" });
    await user.click(reset);
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "계속 편집" }),
    );
    expect(screen.getByLabelText("클라이언트 비밀키")).toHaveValue("synthetic-secret");
    await waitFor(() => expect(reset).toHaveFocus());
    await user.click(reset);
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "변경 버리기" }),
    );
    await waitFor(() => expect(screen.getByLabelText("클라이언트 비밀키")).toHaveValue(""));
    expect(screen.queryByLabelText("2번 Keycloak 역할")).not.toBeInTheDocument();
    expect(api.bodies(path)).toHaveLength(0);
    await waitFor(() => expect(screen.getByRole("button", { name: "SSO 설정 저장" })).toBeEnabled());
    await user.type(input(), "-again");
    await user.click(reset);
    expect(await screen.findByRole("alertdialog")).toBeVisible();
  });

  it("확인창·저장 중 재조회에도 열린 version과 payload를 고정하고 같은 tick 중복 저장을 막는다", async () => {
    const pending = deferred<undefined>();
    const latest = { ...ssoConfig, client_id: "saved", version: 5 };
    const api = mockApi({ [path]: () => pending.promise, "GET /admin/sso/keycloak/config": () => latest });
    const user = userEvent.setup();
    const screenView = setupInline(view());
    await user.type(screen.getByLabelText("클라이언트 비밀키"), "synthetic-secret");
    const dialog = await confirmSave(user);
    screenView.rerender(view({ ...ssoConfig, version: 99, client_id: "concurrent" }));
    const button = dialog.getByRole("button", { name: "저장" });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await waitFor(() => expect(api.bodies(path)).toHaveLength(1));
    expect(api.bodies(path)[0]).toMatchObject({
      client_id: "console",
      client_secret: "synthetic-secret",
      expected_version: 4,
      role_map: { "external-admin": "admin" },
    });
    expect(input()).toBeDisabled();
    expect(screen.getByRole("button", { name: "행 추가", hidden: true })).toBeDisabled();
    expect(dialog.getByRole("button", { name: "취소" })).toBeDisabled();
    await act(async () => pending.resolve(undefined));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByLabelText("클라이언트 비밀키")).toHaveValue("");
    expect(input()).toHaveValue("saved");
    expect(input()).toBeEnabled();
    screenView.rerender(view(latest));
    await user.type(input(), "-new-draft");
    await user.click(screen.getByRole("button", { name: "변경 취소" }));
    expect(await screen.findByRole("alertdialog")).toBeVisible();
    expect(screenView.client.getMutationCache().getAll()).toHaveLength(0);
  });

  it("깨끗한 폼의 저장 확인창도 재조회가 baseline version을 올리지 않는다", async () => {
    const api = mockApi({
      [path]: () => undefined,
      "GET /admin/sso/keycloak/config": () => ({ ...ssoConfig, version: 5 }),
    });
    const user = userEvent.setup();
    const screenView = setupInline(view());
    const dialog = await confirmSave(user);
    screenView.rerender(view({ ...ssoConfig, client_id: "concurrent", version: 8 }));
    await user.click(dialog.getByRole("button", { name: "저장" }));
    expect(api.bodies(path)[0]).toMatchObject({ client_id: "console", expected_version: 4 });
  });

  it("이전 background GET의 늦은 완료는 저장 후 새 version을 덮지 않는다", async () => {
    const oldRead = deferred<KeycloakConfig>();
    const latest = { ...ssoConfig, client_id: "accepted", version: 5 };
    mockApi({ [path]: () => undefined, "GET /admin/sso/keycloak/config": () => latest });
    function LiveForm() {
      const query = useQuery({
        queryKey: systemSettingsKeys.sso,
        initialData: ssoConfig,
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
      read = client.refetchQueries({ queryKey: systemSettingsKeys.sso });
    });
    const dialog = await confirmSave(user);
    await user.click(dialog.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(input()).toHaveValue("accepted"));
    await act(async () => {
      oldRead.resolve(ssoConfig);
      await read;
    });
    expect(input()).toHaveValue("accepted");
    expect(client.getQueryData(systemSettingsKeys.sso)).toMatchObject({ version: 5 });
  });

  it("409는 비밀 초안을 유지하고 재전송을 잠그며 명시 폐기 뒤 새 snapshot으로 편집한다", async () => {
    const api = mockApi({
      [path]: () => {
        throw new AppError("conflict", { kind: "http", status: 409, code: "sso_config_conflict" });
      },
      "GET /admin/sso/keycloak/config": () => ({ ...ssoConfig, version: 9, client_id: "fresh" }),
    });
    const user = userEvent.setup();
    setupInline(view());
    await user.type(screen.getByLabelText("클라이언트 비밀키"), "synthetic-secret");
    const dialog = await confirmSave(user);
    await user.click(dialog.getByRole("button", { name: "저장" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("초안을 보존");
    expect(dialog.getByRole("button", { name: "저장" })).toBeDisabled();
    await user.click(dialog.getByRole("button", { name: "취소" }));
    expect(screen.getByLabelText("클라이언트 비밀키")).toHaveValue("synthetic-secret");
    await user.click(screen.getByRole("button", { name: "최신 설정 다시 불러오기" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "변경 버리기" }),
    );
    await waitFor(() => expect(input()).toHaveValue("fresh"));
    expect(input()).toBeEnabled();
    expect(screen.getByLabelText("클라이언트 비밀키")).toHaveValue("");
    expect(api.bodies(path)).toHaveLength(1);
  });

  it.each(["reload-pending", "read-failed"] as const)(
    "%s는 이미 저장됨을 안내하고 비밀을 지우며 자동 재전송하지 않는다",
    async (outcome) => {
      const api = mockApi({
        [path]: () => {
          if (outcome === "reload-pending")
            throw new AppError("synthetic internal failure", {
              kind: "http",
              status: 500,
              code: "sso_reload_failed",
            });
        },
        "GET /admin/sso/keycloak/config": () => {
          if (outcome === "read-failed") throw apiFailure("read failure");
          return { ...ssoConfig, version: 5 };
        },
      });
      const user = userEvent.setup();
      setupInline(view());
      await user.type(input(), "-committed");
      await user.type(screen.getByLabelText("클라이언트 비밀키"), "synthetic-secret");
      const dialog = await confirmSave(user);
      await user.click(dialog.getByRole("button", { name: "저장" }));
      expect(await screen.findByText("저장 상태 확인")).toBeVisible();
      expect(screen.getByLabelText("클라이언트 비밀키")).toHaveValue("");
      expect(screen.getByRole("button", { name: "SSO 설정 저장" })).toBeDisabled();
      expect(api.bodies(path)).toHaveLength(1);
      expect(screen.queryByText("synthetic internal failure")).not.toBeInTheDocument();
      const unload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(false);
    },
  );

  it.each(["keep", "replace", "clear"] as const)(
    "비밀 %s와 기본 매핑 초기화 payload 의미를 보존한다",
    async (mode) => {
      const api = mockApi({
        [path]: () => undefined,
        "GET /admin/sso/keycloak/config": () => ({ ...ssoConfig, version: 5 }),
      });
      const user = userEvent.setup();
      setupInline(view());
      if (mode === "replace") await user.type(screen.getByLabelText("클라이언트 비밀키"), "synthetic-secret");
      if (mode === "clear") await user.click(screen.getByLabelText("저장된 클라이언트 비밀키 지우기"));
      await user.click(screen.getByRole("button", { name: "매핑을 기본값으로 초기화" }));
      const dialog = within(await screen.findByRole("dialog"));
      await user.click(dialog.getByRole("button", { name: "저장" }));
      const body = api.bodies(path)[0];
      expect(body).toMatchObject({ role_map: {}, scopes: ["openid", "profile"], expected_version: 4 });
      if (mode === "keep") expect(body).not.toHaveProperty("client_secret");
      else expect(body).toHaveProperty("client_secret", mode === "clear" ? "" : "synthetic-secret");
    },
  );

  it("저장 후 재적재 실패 안내는 탭 재진입·명시 GET 후에도 남고 동일 snapshot 재전송은 막는다", async () => {
    const latest = { ...ssoConfig, version: 5 };
    const api = mockApi({
      [path]: () => {
        throw new AppError("reload", { kind: "http", status: 500, code: "sso_reload_failed" });
      },
      "GET /admin/sso/keycloak/config": () => latest,
    });
    const user = userEvent.setup();
    const screenView = setupInline(view());
    await user.type(input(), "-saved");
    const dialog = await confirmSave(user);
    await user.click(dialog.getByRole("button", { name: "저장" }));
    expect(await screen.findByText("저장 상태 확인")).toBeVisible();
    screenView.rerender(<p>다른 탭</p>);
    screenView.rerender(view(latest));
    expect(screen.getByText(/실제 로그인 적용이나 모든 파드의 활성 상태를 증명하지 않습니다/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "최신 설정 다시 불러오기" }));
    await waitFor(() => expect(input()).toBeEnabled());
    expect(screen.getByText("저장 상태 확인")).toBeVisible();
    expect(screen.getByRole("button", { name: "SSO 설정 저장" })).toBeDisabled();
    expect(api.bodies(path)).toHaveLength(1);
    await user.type(input(), "-new-change");
    expect(screen.getByRole("button", { name: "SSO 설정 저장" })).toBeEnabled();
  });

  it.each(["   ", "********"])("비밀키 %j 입력은 명시 삭제로 오해하지 않는다", async (value) => {
    const api = mockApi({});
    const user = userEvent.setup();
    setupInline(view());
    await user.type(screen.getByLabelText("클라이언트 비밀키"), value);
    await user.click(screen.getByRole("button", { name: "SSO 설정 저장" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("비밀키로 저장할 수 없습니다");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it("권한 없는 폼은 입력과 매핑 초기화·저장을 모두 잠근다", () => {
    const api = mockApi({});
    setupInline(view(ssoConfig, false));
    expect(input()).toBeDisabled();
    expect(screen.getByLabelText("클라이언트 비밀키")).toBeDisabled();
    expect(screen.getByRole("button", { name: "매핑을 기본값으로 초기화" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "SSO 설정 저장" })).toBeDisabled();
    expect(api.calls).toHaveLength(0);
  });

  it("매핑 초기화 확인을 취소하면 원래 초기화 버튼에 포커스를 돌린다", async () => {
    const api = mockApi({});
    const user = userEvent.setup();
    setupInline(view());
    const trigger = screen.getByRole("button", { name: "매핑을 기본값으로 초기화" });
    await user.click(trigger);
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "취소" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(api.calls).toHaveLength(0);
  });

  it.each(["resolve", "reject"] as const)(
    "보안 폐기는 pending %s 뒤 새 초안·캐시·toast를 바꾸지 않는다",
    async (outcome) => {
      const pending = deferred<undefined>();
      const saved = vi.spyOn(toast, "success").mockImplementation(() => "toast");
      mockApi({
        [path]: () => pending.promise,
        "GET /admin/sso/keycloak/config": () => ({ ...ssoConfig, client_id: "old-result", version: 5 }),
      });
      const user = userEvent.setup();
      const { client } = setupInline(view());
      await user.type(screen.getByLabelText("클라이언트 비밀키"), "synthetic-secret");
      const dialog = await confirmSave(user);
      await user.click(dialog.getByRole("button", { name: "저장" }));
      act(() => publishLogout());
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByLabelText("클라이언트 비밀키")).toHaveValue("");
      await act(async () =>
        outcome === "resolve" ? pending.resolve(undefined) : pending.reject(apiFailure("old-error")),
      );
      await waitFor(() => expect(input()).toBeEnabled());
      await user.type(input(), "-fresh");
      expect(input()).toHaveValue("console-fresh");
      expect(client.getQueryData<KeycloakConfig>(systemSettingsKeys.sso)).toBeUndefined();
      expect(saved).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );
});
