import { act, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useReducer } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RolePermissionMatrix } from "./RolePermissionMatrix";
import { matrixRows, roleMatrixSchema } from "./role-permission-matrix";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({ id: "matrix_admin", read: true }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => testAuth({ user: { id: runtime.id }, scopes: runtime.read ? ["admin:read"] : [] }),
  };
});
beforeEach(() => {
  runtime.id = "matrix_admin";
  runtime.read = true;
});
const catalog = {
  roles: [
    { role: "developer", scopes: ["models:read", "chat:completion"] },
    { role: "viewer", scopes: ["models:read"] },
    { role: "custom_reviewer", scopes: ["future:review"] },
    { role: "no_grants", scopes: null },
  ],
  all_scopes: ["models:read", "chat:completion", "admin:write"],
};
function setup(handler: ApiHandler = () => catalog) {
  const api = mockApi({ "GET /admin/roles": handler });
  const close = vi.fn();
  let refresh = () => undefined;
  function Host() {
    const [, force] = useReducer((n: number) => n + 1, 0);
    refresh = () => {
      force();
      return undefined;
    };
    return (
      <FeatureAccessContext.Provider value={{ featureId: "access.users", permitted: true, readOnly: true }}>
        <RolePermissionMatrix onClose={close} returnFocusRef={createRef()} />
      </FeatureAccessContext.Provider>
    );
  }
  const view = renderScreen(<Host />);
  return { api, close, view, refresh: () => act(() => refresh()) };
}
describe("역할별 권한 비교", () => {
  it("조회 전용에서도 한글 이름과 정확한 포함 여부를 표시하고 쓰지 않는다", async () => {
    const { api, view } = setup();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("대화 생성")).toBeInTheDocument();
    const row = within(table).getByRole("row", { name: /대화 생성/ });
    expect(
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["부여됨", "미부여"]);
    expect(api.calls.map((call) => call.key)).toEqual(["GET /admin/roles"]);
    view.unmount();
    await waitFor(() => expect(view.client.getQueryCache().getAll()).toHaveLength(0));
  });
  it("차이만 필터·한글 검색·초기화를 적용하고 초기화 후 검색에 초점을 둔다", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole("table");
    await user.click(screen.getByRole("checkbox", { name: "차이가 있는 권한만" }));
    expect(screen.getByRole("table")).not.toHaveTextContent("모델 조회");
    await user.type(screen.getByRole("textbox", { name: "권한 검색" }), "비용");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("현재 검색 조건에서 차이가 있는 권한이 없습니다.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "검색·필터 초기화" }));
    expect(screen.getByRole("textbox", { name: "권한 검색" })).toHaveFocus();
    expect(screen.getByRole("table")).toHaveTextContent("모델 조회");
  });
  it("중복 역할 선택을 막고 알 수 없는 권한도 누락하지 않는다", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole("table");
    const third = screen.getByRole("combobox", { name: "비교 역할 3" });
    expect(within(third).queryByRole("option", { name: /developer/ })).not.toBeInTheDocument();
    await user.selectOptions(third, "custom_reviewer");
    const row = screen.getByRole("row", { name: /future:review/ });
    expect(row).toHaveTextContent("현재 권한 목록에 없음");
    expect(
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["미부여", "미부여", "부여됨"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "비교 역할 4" }), "no_grants");
    expect(screen.getByRole("table")).not.toHaveTextContent("상속");
  });
  it("하나 이하를 선택하면 차이가 없다고 오해시키지 않는다", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole("table");
    await user.selectOptions(screen.getByRole("combobox", { name: "비교 역할 2" }), "");
    expect(screen.getByText("비교할 역할을 두 개 이상 선택하세요.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
  it("조회 실패를 빈 권한으로 바꾸지 않고 수동 조회 후 복구한다", async () => {
    const user = userEvent.setup();
    let fail = true;
    const { api } = setup(() => {
      if (fail) throw apiFailure("private role failure", 503);
      return catalog;
    });
    await screen.findByText("역할 목록을 확인하지 못했습니다. 목록을 다시 조회하세요.");
    expect(screen.queryByText("private role failure")).not.toBeInTheDocument();
    expect(api.calls).toHaveLength(1);
    fail = false;
    await user.click(screen.getByRole("button", { name: "목록 새로 조회" }));
    await screen.findByRole("table");
    expect(api.calls).toHaveLength(2);
  });
  it.each(["identity", "read"])("%s 변경 시 기존 권한과 선택을 숨긴다", async (change) => {
    const { refresh, close } = setup();
    await screen.findByRole("table");
    if (change === "identity") runtime.id = "another_user";
    else runtime.read = false;
    refresh();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(close).toHaveBeenCalled();
  });
  it("누락된 권한과 중복 역할은 엄격한 비교 계약에서 거부한다", () => {
    expect(roleMatrixSchema.safeParse({ roles: [{ role: "a" }], all_scopes: [] }).success).toBe(false);
    expect(
      roleMatrixSchema.safeParse({ ...catalog, roles: [catalog.roles[0], catalog.roles[0]] }).success,
    ).toBe(false);
    expect(roleMatrixSchema.safeParse({ roles: [], all_scopes: [] }).success).toBe(true);
    expect(roleMatrixSchema.safeParse(catalog).success).toBe(true);
  });
  it("빈 권한은 상속으로 해석하지 않고 알 수 없는 권한은 있는 그대로 비교한다", () => {
    const rows = matrixRows(catalog, ["no_grants", "custom_reviewer"], "future", true);
    expect(rows).toEqual([
      { scope: "future:review", title: "기타 권한", registered: false, grants: [false, true] },
    ]);
  });
});
