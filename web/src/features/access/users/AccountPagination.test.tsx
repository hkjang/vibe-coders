import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { UsersTab } from "./UsersTab";
import type { AccountQuery } from "@/shared/api/domains/account-page.schemas";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => ({
      ...testAuth({ role: "admin", scopes: ["admin:read", "admin:write"] }),
      credentialPrefixes: ["corp_"],
    }),
  };
});
const rows = Array.from({ length: 52 }, (_, index) => ({
  id: `usr_account_${index}`,
  email: `account-${index}@example.test`,
  name: `계정 ${index}`,
  role: "developer",
  status: "active",
  team_id: "team_a",
  team_name: "개발팀",
  created_at: "2026-11-12T00:00:00Z",
}));
function Host() {
  const location = useLocation();
  return (
    <FeatureAccessContext.Provider value={{ featureId: "access.users", permitted: true, readOnly: false }}>
      <output aria-label="현재 조회 주소">{location.search}</output>
      <UsersTab canWrite writeDeniedReason="변경 불가" />
    </FeatureAccessContext.Provider>
  );
}
function setup(route = "/access/users", accounts?: ApiHandler) {
  const api = mockApi({
    "GET /admin/users": (options, endpoint) => {
      const query = options.query as AccountQuery;
      if (query.view !== "accounts") return { users: [], team_names: {} };
      if (accounts) return accounts(options, endpoint);
      return {
        accounts: rows.slice(query.offset, query.offset + query.limit),
        total: rows.length,
        limit: query.limit,
        offset: query.offset,
      };
    },
    "GET /admin/benchmark/users": () => ({ users: [] }),
  });
  const view = renderScreen(<Host />, { route });
  return { api, view };
}
const pageCalls = (api: ReturnType<typeof mockApi>) =>
  api.calls.filter((call) => (call.options.query as { view?: string })?.view === "accounts");

describe("로그인 계정 서버 페이지", () => {
  it("25개씩 서버에 요청하고 다음 페이지 주소와 실제 행을 바꾼다", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await screen.findByText("account-0@example.test");
    expect(screen.queryByText("account-25@example.test")).not.toBeInTheDocument();
    expect(screen.getByText(/검색 결과 52개 계정/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "다음" }));
    expect(await screen.findByText("account-25@example.test")).toBeVisible();
    expect(screen.queryByText("account-0@example.test")).not.toBeInTheDocument();
    expect(pageCalls(api).map((call) => call.options.query)).toEqual([
      { view: "accounts", limit: 25, offset: 0 },
      { view: "accounts", limit: 25, offset: 25 },
    ]);
    expect(screen.getByLabelText("현재 조회 주소")).toHaveTextContent("account_page=2");
    await user.selectOptions(screen.getByRole("combobox", { name: "페이지당 표시 건수" }), "10");
    await waitFor(() =>
      expect(pageCalls(api).at(-1)?.options.query).toEqual({ view: "accounts", limit: 10, offset: 0 }),
    );
  });
  it("직접 접근의 필터·정렬을 첫 서버 요청부터 적용한다", async () => {
    const { api } = setup(
      "/access/users?account_q=%25_%21&account_status=disabled&account_role=viewer&account_team=none&account_sort=role:asc,email:desc&account_size=10&account_page=3",
    );
    await waitFor(() => expect(pageCalls(api)).toHaveLength(1));
    expect(pageCalls(api)[0]?.options.query).toEqual({
      view: "accounts",
      q: "%_!",
      status: "disabled",
      role: "viewer",
      team_id: "",
      sort: "role:asc,email:desc",
      limit: 10,
      offset: 20,
    });
    expect(screen.getByLabelText("계정 검색")).toHaveValue("%_!");
    expect(screen.getByLabelText("계정 상태")).toHaveValue("disabled");
    expect(screen.getByLabelText("소속 팀")).toHaveValue("none");
  });
  it("검색 적용은 서버에 새 조회를 보내고 페이지를 초기화한다", async () => {
    const user = userEvent.setup();
    const { api } = setup("/access/users?account_page=2");
    await screen.findByText("account-25@example.test");
    await user.type(screen.getByLabelText("계정 검색"), "개발 %_!");
    expect(pageCalls(api)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "필터 적용" }));
    await waitFor(() => expect(pageCalls(api)).toHaveLength(2));
    expect(pageCalls(api).at(-1)?.options.query).toMatchObject({ q: "개발 %_!", offset: 0 });
    expect(screen.getByLabelText("현재 조회 주소")).not.toHaveTextContent("account_page");
  });
  it("비밀값은 URL이나 조회에 넣지 않고 첫 오류 입력에 포커스를 둔다", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await screen.findByText("account-0@example.test");
    const input = screen.getByLabelText("계정 검색");
    await user.type(input, "corp_" + "A".repeat(43));
    await user.click(screen.getByRole("button", { name: "필터 적용" }));
    expect(input).toHaveFocus();
    expect(pageCalls(api)).toHaveLength(1);
    expect(screen.getByLabelText("현재 조회 주소")).not.toHaveTextContent("corp_");
    expect(screen.getByRole("alert")).toHaveTextContent("비밀값");
  });
  it("다중 정렬은 최대 세 기준까지 서버로 전송한다", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await screen.findByText("account-0@example.test");
    await user.click(screen.getByRole("button", { name: "다중 정렬" }));
    const dialog = within(screen.getByRole("dialog", { name: "다중 정렬 설정" }));
    const add = dialog.getByRole("button", { name: "정렬 기준 추가" });
    await user.click(add);
    await user.click(add);
    await user.click(add);
    expect(add).toBeDisabled();
    await user.click(dialog.getByRole("button", { name: "정렬 적용" }));
    await waitFor(() =>
      expect(pageCalls(api).at(-1)?.options.query).toMatchObject({ sort: "email:asc,name:asc,role:asc" }),
    );
  });
  it("계정 조회 실패를 0건으로 표현하지 않고 키 요약을 유지하며 재시도한다", async () => {
    let attempts = 0;
    const user = userEvent.setup();
    setup("/access/users", ({ query }) => {
      if (++attempts === 1) throw apiFailure("fixture private", 500, "req_account_page");
      const value = query as AccountQuery;
      return { accounts: [rows[0]], total: 1, limit: value.limit, offset: value.offset };
    });
    expect(await screen.findByText("로그인 계정을(를) 불러오지 못했습니다.")).toBeVisible();
    expect(screen.getByText(/계정 수 미확인/)).toBeVisible();
    expect(screen.queryByText(/검색 결과 0개 계정/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("키 사용량 요약")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("account-0@example.test")).toBeVisible();
  });
  it.each(["wrong-offset", "duplicate", "missing-total"])(
    "잘못된 응답 %s는 계정 표에 표시하지 않는다",
    async (kind) => {
      setup("/access/users", ({ query }) => ({
        accounts: kind === "duplicate" ? [rows[0], rows[0]] : [rows[0]],
        total: kind === "missing-total" ? undefined : kind === "duplicate" ? 2 : 1,
        limit: (query as AccountQuery).limit,
        offset: kind === "wrong-offset" ? 25 : 0,
      }));
      expect(await screen.findByText("로그인 계정을(를) 불러오지 못했습니다.")).toBeVisible();
      expect(screen.queryByText("account-0@example.test")).not.toBeInTheDocument();
    },
  );
});
