import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useReducer } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserAccountDialog } from "./UserAccountDialog";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({
  id: "usr_admin",
  readOnly: false,
  role: "super_admin",
  writeScope: true,
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({
        role: runtime.role,
        user: { id: runtime.id },
        scopes: runtime.writeScope ? ["admin:read", "admin:write"] : ["admin:read"],
      }),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
beforeEach(() => {
  runtime.id = "usr_admin";
  runtime.readOnly = false;
  runtime.role = "super_admin";
  runtime.writeScope = true;
});
const account = {
  id: "usr_custom",
  email: "custom@example.invalid",
  name: "검토자",
  role: "custom_reviewer",
  status: "active",
  team_id: "team-test",
  created_at: "2026-10-01T00:00:00Z",
};
const catalog = (roles = ["developer", "viewer", "custom_reviewer"]) => ({
  roles: roles.map((role) => ({ role })),
  all_scopes: [],
});
function setup(edit = false, handlers: Record<string, ApiHandler> = {}) {
  const api = mockApi({
    "GET /admin/roles": () => catalog(),
    "POST /admin/users": () => ({ user: account }),
    "PATCH /admin/users/usr_custom": () => ({ user: account }),
    ...handlers,
  });
  const close = vi.fn();
  let refresh = () => undefined;
  function Host() {
    const [, force] = useReducer((n: number) => n + 1, 0);
    refresh = () => {
      force();
      return undefined;
    };
    return (
      <FeatureAccessContext.Provider
        value={{ featureId: "access.users", permitted: true, readOnly: runtime.readOnly }}
      >
        <UserAccountDialog
          user={edit ? account : undefined}
          canWrite
          writeDeniedReason="변경 권한 없음"
          onClose={close}
          returnFocusRef={createRef()}
        />
      </FeatureAccessContext.Provider>
    );
  }
  const view = renderScreen(<Host />);
  return { api, close, view, refresh: () => act(() => refresh()) };
}
async function fillCreate(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("이메일", { exact: false }), "new@example.invalid");
  await user.type(screen.getByLabelText("비밀번호", { exact: false }), "synthetic-password");
  const role = screen.getByRole("combobox", { name: "역할" });
  await within(role).findByRole("option", { name: "custom_reviewer" });
  await user.selectOptions(role, "custom_reviewer");
}
function deferred() {
  let resolve!: (value: ReturnType<typeof catalog>) => void;
  const promise = new Promise<ReturnType<typeof catalog>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe("서버 역할 목록 기반 사용자 편집", () => {
  it("사용자 정의 역할로 등록하고 저장 직전에 목록을 다시 조회한다", async () => {
    const user = userEvent.setup();
    const { api, close, view } = setup();
    await fillCreate(user);
    await user.click(screen.getByRole("button", { name: "등록" }));
    await waitFor(() =>
      expect(api.bodies("POST /admin/users")).toEqual([
        { email: "new@example.invalid", password: "synthetic-password", role: "custom_reviewer" },
      ]),
    );
    expect(api.calls.map((call) => call.key)).toEqual([
      "GET /admin/roles",
      "GET /admin/roles",
      "POST /admin/users",
    ]);
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(api.spy.mock.calls.find(([endpoint]) => endpoint.method === "POST")?.[1]).toMatchObject({
      retryUnauthorized: false,
    });
    view.unmount();
    await waitFor(() => expect(view.client.getMutationCache().getAll().length).toBe(0));
  });
  it("기존 사용자 정의 역할을 다른 내장 역할로 바꾸지 않고 상태만 변경한다", async () => {
    const user = userEvent.setup();
    const { api } = setup(true);
    await screen.findByRole("option", { name: "custom_reviewer" });
    expect(screen.getByRole("combobox", { name: "역할" })).toHaveValue("custom_reviewer");
    await user.selectOptions(screen.getByRole("combobox", { name: "상태" }), "disabled");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(api.bodies("PATCH /admin/users/usr_custom")).toEqual([
        { role: "custom_reviewer", status: "disabled", team_id: "team-test" },
      ]),
    );
  });
  it("목록 오류에서는 저장을 막고 입력을 유지한 채 수동 재조회한다", async () => {
    const user = userEvent.setup();
    let fail = true;
    const { api } = setup(false, {
      "GET /admin/roles": () => {
        if (fail) throw apiFailure("private role data", 503);
        return catalog();
      },
    });
    await screen.findByText("역할 목록을 불러오지 못했습니다.");
    await user.type(screen.getByLabelText("이메일", { exact: false }), "kept@example.invalid");
    expect(screen.getByRole("button", { name: "등록" })).toBeDisabled();
    expect(screen.queryByText("private role data")).not.toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "역할 목록 다시 조회" }));
    await screen.findByRole("option", { name: "custom_reviewer" });
    expect(screen.getByLabelText("이메일", { exact: false })).toHaveValue("kept@example.invalid");
    expect(api.bodies("POST /admin/users")).toEqual([]);
  });
  it("저장 직전에 삭제된 역할은 전송하지 않고 명시적인 새 선택을 요구한다", async () => {
    const user = userEvent.setup();
    let reads = 0;
    const { api } = setup(true, {
      "GET /admin/roles": () => (++reads === 1 ? catalog() : catalog(["viewer"])),
    });
    await screen.findByRole("option", { name: "custom_reviewer" });
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText("선택한 역할이 목록에 없습니다. 다른 역할을 명시적으로 선택하세요.");
    expect(api.bodies("PATCH /admin/users/usr_custom")).toEqual([]);
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
    await user.selectOptions(screen.getByRole("combobox", { name: "역할" }), "viewer");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(api.bodies("PATCH /admin/users/usr_custom")).toHaveLength(1));
  });
  it.each(["readonly", "identity", "scope"])(
    "저장 전 재조회 중 %s 변경이면 늦은 목록으로 쓰지 않는다",
    async (change) => {
      const user = userEvent.setup();
      const pending = deferred();
      let reads = 0;
      const { api, refresh, close } = setup(true, {
        "GET /admin/roles": () => (++reads === 1 ? catalog() : pending.promise),
      });
      await screen.findByRole("option", { name: "custom_reviewer" });
      await user.click(screen.getByRole("button", { name: "저장" }));
      await waitFor(() => expect(reads).toBe(2));
      if (change === "readonly") runtime.readOnly = true;
      else if (change === "scope") runtime.writeScope = false;
      else runtime.id = "usr_other";
      refresh();
      await act(async () => {
        pending.resolve(catalog());
        await pending.promise;
      });
      expect(api.bodies("PATCH /admin/users/usr_custom")).toEqual([]);
      if (change === "identity") {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(close).toHaveBeenCalled();
      } else expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
    },
  );
  it.each([[], ["viewer", "viewer"], [""], ["vc_sk_" + "a".repeat(40)]].map((roles) => ({ roles })))(
    "불완전하거나 중복된 목록 $roles에는 역할을 자동 대입하지 않는다",
    async ({ roles }) => {
      setup(true, { "GET /admin/roles": () => catalog(roles) });
      await screen.findByText("역할 목록을 불러오지 못했습니다.");
      expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
    },
  );
});
