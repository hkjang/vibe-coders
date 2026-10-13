import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { RolesTab } from "./RolesTab";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({ id: "role_operator", role: "admin", readOnly: false, write: true }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({
        user: { id: runtime.id },
        role: runtime.role,
        scopes: runtime.write ? ["admin:read", "admin:write"] : ["admin:read"],
      }),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
beforeEach(() => {
  runtime.id = "role_operator";
  runtime.role = "admin";
  runtime.readOnly = false;
  runtime.write = true;
  vi.clearAllMocks();
});
const custom = {
  role: "custom_reviewer",
  scopes: ["models:read"],
  description: "검토 담당",
  default_home: "#/me",
  is_system: false,
  is_admin: false,
  rank: 0,
};
const builtin = { ...custom, role: "admin", is_system: true, rank: 90 };
const catalog = { roles: [builtin, custom], all_scopes: ["models:read", "admin:read"] };
function setup(handlers: Record<string, ApiHandler> = {}) {
  const api = mockApi({
    "GET /admin/roles": () => catalog,
    "POST /admin/roles": () => ({ role: custom }),
    "DELETE /admin/roles": () => ({ deleted: true }),
    ...handlers,
  });
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
        <RolesTab canWrite={runtime.write} writeDeniedReason="변경 권한 없음" />
      </FeatureAccessContext.Provider>
    );
  }
  const view = renderScreen(<Host />);
  return { api, view, refresh: () => act(() => refresh()) };
}
async function edit(user: ReturnType<typeof userEvent.setup>) {
  const row = (await screen.findByText("custom_reviewer")).closest("tr");
  if (!row) throw new Error("역할 행 없음");
  await user.click(within(row).getByRole("button", { name: "수정" }));
  return within(await screen.findByRole("dialog", { name: "역할 수정" }));
}
describe("역할 변경의 현재 목록과 권한", () => {
  it("역할 추가로 이미 등록된 사용자 정의 역할을 덮어쓰지 않는다", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await user.click(await screen.findByRole("button", { name: "역할 추가" }));
    const dialog = within(await screen.findByRole("dialog", { name: "역할 추가" }));
    await user.type(dialog.getByLabelText("역할 이름", { exact: false }), "custom_reviewer");
    await user.click(dialog.getByRole("button", { name: "저장" }));
    expect(api.bodies("POST /admin/roles")).toHaveLength(0);
    await waitFor(() => expect(api.calls.filter((call) => call.key === "GET /admin/roles")).toHaveLength(2));
    expect(
      await screen.findAllByText("이미 등록된 역할 이름입니다. 목록의 수정 기능을 이용하세요."),
    ).not.toHaveLength(0);
  });
  it("편집을 연 뒤 서버에서 바뀐 역할은 이전 초안으로 덮어쓰지 않는다", async () => {
    const user = userEvent.setup();
    let reads = 0;
    const { api } = setup({
      "GET /admin/roles": () =>
        ++reads === 1
          ? catalog
          : { ...catalog, roles: [builtin, { ...custom, description: "다른 관리자의 변경" }] },
    });
    const dialog = await edit(user);
    await user.click(dialog.getByRole("button", { name: "저장" }));
    expect(api.bodies("POST /admin/roles")).toHaveLength(0);
    await waitFor(() => expect(reads).toBe(2));
  });
  it.each(["readonly", "scope"])("열린 편집창의 %s 회수 후 저장하지 않고 초안을 유지한다", async (change) => {
    const user = userEvent.setup();
    const { api, refresh } = setup();
    const dialog = await edit(user);
    await user.type(dialog.getByLabelText("설명"), " 유지할 초안");
    if (change === "readonly") runtime.readOnly = true;
    else runtime.write = false;
    refresh();
    expect(dialog.getByRole("button", { name: "저장" })).toBeDisabled();
    expect(dialog.getByLabelText("설명")).toHaveValue("검토 담당 유지할 초안");
    expect(api.bodies("POST /admin/roles")).toHaveLength(0);
  });
  it("한글 권한 선택의 코드를 보존하고 저장 뒤 편집 버튼으로 초점을 돌린다", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    const dialog = await edit(user);
    await user.click(dialog.getByRole("checkbox", { name: "관리 정보 조회 (admin:read)" }));
    await user.click(dialog.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.bodies("POST /admin/roles")).toEqual([
      {
        role: custom.role,
        description: custom.description,
        default_home: custom.default_home,
        scopes: ["admin:read", "models:read"],
      },
    ]);
    expect(api.spy.mock.calls.find(([endpoint]) => endpoint.method === "POST")?.[1]).toMatchObject({
      retryUnauthorized: false,
    });
    const row = screen.getByText(custom.role).closest("tr");
    if (!row) throw new Error("역할 행 없음");
    expect(within(row).getByRole("button", { name: "수정" })).toHaveFocus();
  });
  it("확인 이후 변경된 역할은 삭제하지 않는다", async () => {
    const user = userEvent.setup();
    let reads = 0;
    const { api } = setup({
      "GET /admin/roles": () =>
        ++reads === 1 ? catalog : { ...catalog, roles: [builtin, { ...custom, scopes: [] }] },
    });
    const row = (await screen.findByText(custom.role)).closest("tr");
    if (!row) throw new Error("역할 행 없음");
    await user.click(within(row).getByRole("button", { name: "삭제" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "역할 삭제" })).getByRole("button", { name: "삭제" }),
    );
    await waitFor(() => expect(reads).toBe(2));
    expect(api.calls.filter((call) => call.key === "DELETE /admin/roles")).toHaveLength(0);
  });
  it.each(["readonly", "scope", "identity"])(
    "요청 전송 후 %s 변경이면 늦은 성공 알림과 닫기를 실행하지 않는다",
    async (change) => {
      const user = userEvent.setup();
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const { api, view, refresh } = setup({
        "POST /admin/roles": async () => {
          await held;
          return { role: custom };
        },
      });
      const invalidate = vi.spyOn(view.client, "invalidateQueries");
      const dialog = await edit(user);
      await user.click(dialog.getByRole("button", { name: "저장" }));
      await waitFor(() => expect(api.bodies("POST /admin/roles")).toHaveLength(1));
      if (change === "readonly") runtime.readOnly = true;
      else if (change === "scope") runtime.write = false;
      else runtime.id = "another_operator";
      refresh();
      await act(async () => {
        finish();
        await held;
      });
      await waitFor(() => expect(view.client.isMutating()).toBe(0));
      expect(invalidate).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      if (change === "identity") expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      else expect(screen.getByRole("dialog", { name: "역할 수정" })).toBeInTheDocument();
    },
  );
  it("같은 계정의 조회 수명이 바뀌어도 진행 중 역할 변경을 중복 전송하지 않는다", async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { api, view, refresh } = setup({
      "POST /admin/roles": async () => {
        await held;
        return { role: custom };
      },
    });
    let dialog = await edit(user);
    await user.click(dialog.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(api.bodies("POST /admin/roles")).toHaveLength(1));
    runtime.role = "ops_admin";
    refresh();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    dialog = await edit(user);
    await user.click(dialog.getByRole("button", { name: "저장" }));
    await screen.findByText("역할 변경을 처리 중입니다. 완료 후 다시 확인하세요.");
    expect(api.bodies("POST /admin/roles")).toHaveLength(1);
    await act(async () => {
      finish();
      await held;
    });
    await waitFor(() => expect(view.client.isMutating()).toBe(0));
    expect(screen.getByRole("dialog", { name: "역할 수정" })).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });
  it("조회 403은 이전 역할과 열린 초안을 제거한다", async () => {
    const user = userEvent.setup();
    let reads = 0;
    setup({
      "GET /admin/roles": () => {
        if (++reads > 1) throw apiFailure("private role names", 403);
        return catalog;
      },
    });
    const dialog = await edit(user);
    await user.click(dialog.getByRole("button", { name: "저장" }));
    await screen.findByRole("heading", { name: "역할 조회 권한을 다시 확인하세요." });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(custom.role)).not.toBeInTheDocument();
    expect(screen.queryByText("private role names")).not.toBeInTheDocument();
  });
});
