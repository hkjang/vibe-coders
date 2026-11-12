import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import type { AccountQuery } from "@/shared/api/domains/account-page.schemas";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";
import { UsersTab } from "./UsersTab";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => ({
      ...testAuth({ role: "admin", scopes: ["admin:read"] }),
      credentialPrefixes: ["corp_"],
    }),
  };
});
const account = {
  id: "usr_one",
  email: "detail@example.test",
  name: "상세 사용자",
  role: "viewer",
  status: "disabled",
  team_id: "team_a",
  team_name: "개발팀",
  created_at: "2026-11-12T01:00:00Z",
};
function Host() {
  const location = useLocation();
  return (
    <FeatureAccessContext.Provider value={{ featureId: "access.users", permitted: true, readOnly: true }}>
      <output aria-label="현재 주소">{location.search}</output>
      <UsersTab canWrite={false} writeDeniedReason="조회 전용입니다." />
    </FeatureAccessContext.Provider>
  );
}
function setup(route = "/access/users/accounts", detail?: ApiHandler) {
  const api = mockApi({
    "GET /admin/users": (options, endpoint) => {
      const query = options.query as AccountQuery;
      if (query.view !== "accounts") return { users: [], team_names: {} };
      if (query.id && detail) return detail(options, endpoint);
      return { accounts: [account], total: 1, limit: query.limit, offset: query.offset };
    },
    "GET /admin/benchmark/users": () => ({ users: [] }),
  });
  renderScreen(<Host />, { route });
  return api;
}
const details = (api: ReturnType<typeof mockApi>) =>
  api.calls.filter((call) => (call.options.query as AccountQuery | undefined)?.id !== undefined);

describe("로그인 계정 읽기 전용 상세", () => {
  it("조회 권한으로 상세를 열고 목록 필터와 닫기 초점을 보존한다", async () => {
    const user = userEvent.setup();
    const api = setup("/access/users/accounts?account_q=detail&account_size=10");
    const link = await screen.findByRole("link", { name: "detail@example.test 계정 상세 보기" });
    expect(link).toHaveAttribute("href", expect.stringContaining("account_id=usr_one"));
    await user.click(link);
    const panel = within(await screen.findByRole("dialog", { name: "로그인 계정 상세" }));
    expect(await panel.findByText("usr_one")).toBeVisible();
    expect(panel.getByText("중지")).toBeVisible();
    expect(panel.getByText("개발팀")).toBeVisible();
    expect(panel.queryByRole("button", { name: /수정|저장/ })).not.toBeInTheDocument();
    expect(details(api).at(-1)?.options.query).toEqual({
      view: "accounts",
      id: "usr_one",
      limit: 1,
      offset: 0,
    });
    await user.click(panel.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(link).toHaveFocus();
    expect(screen.getByLabelText("현재 주소")).toHaveTextContent("account_size=10");
    expect(screen.getByLabelText("현재 주소")).not.toHaveTextContent("account_id");
    expect(api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
  });
  it("현재 페이지 밖의 계정을 긴 한글·예약 문자 ID 그대로 조회한다", async () => {
    const id = " 계정/%_! " + "가".repeat(1024);
    const api = setup(`/access/users/accounts?account_page=2&account_id=${encodeURIComponent(id)}`, () => ({
      accounts: [{ ...account, id, name: "주소로 연 계정" }],
      total: 1,
      limit: 1,
      offset: 0,
    }));
    expect(await within(await screen.findByRole("dialog")).findByText("주소로 연 계정")).toBeVisible();
    expect(details(api)[0]?.options.query).toEqual({ view: "accounts", id, limit: 1, offset: 0 });
  });
  it.each([
    ["빈 ID", "account_id="],
    ["중복 ID", "account_id=one&account_id=two"],
    ["너무 긴 ID", `account_id=${"x".repeat(4097)}`],
    ["제어 문자", "account_id=one%0Atwo"],
  ])("잘못된 주소 %s를 상세 API로 보내지 않는다", async (_label, query) => {
    const api = setup(`/access/users/accounts?${query}`);
    expect(await screen.findByText("계정 상세 주소를 확인하세요.")).toBeVisible();
    await screen.findByText("detail@example.test");
    expect(details(api)).toHaveLength(0);
  });
  it("비밀값처럼 보이는 ID는 주소에서 제거하고 요청하지 않는다", async () => {
    const api = setup(`/access/users/accounts?account_id=corp_${"A".repeat(43)}`);
    await screen.findByText("detail@example.test");
    expect(details(api)).toHaveLength(0);
    expect(screen.getByLabelText("현재 주소")).not.toHaveTextContent("corp_");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("삭제되거나 범위 밖인 계정을 다른 계정으로 대체하지 않는다", async () => {
    setup("/access/users/accounts?account_id=missing", () => ({
      accounts: [],
      total: 0,
      limit: 1,
      offset: 0,
    }));
    const panel = within(await screen.findByRole("dialog"));
    expect(await panel.findByText("조회 가능한 로그인 계정이 없습니다.")).toBeVisible();
    expect(panel.queryByText(account.email)).not.toBeInTheDocument();
  });
  it.each(["identity", "total", "offset", "type"])(
    "상세 응답 %s가 맞지 않으면 표시하지 않는다",
    async (kind) => {
      setup("/access/users/accounts?account_id=usr_one", () => ({
        accounts: [
          {
            ...account,
            id: kind === "identity" ? "usr_other" : account.id,
            email: kind === "type" ? 42 : account.email,
          },
        ],
        total: kind === "total" ? 2 : 1,
        limit: 1,
        offset: kind === "offset" ? 1 : 0,
      }));
      const panel = within(await screen.findByRole("dialog"));
      expect(await panel.findByText("로그인 계정 상세 조회 실패")).toBeVisible();
      expect(panel.queryByText(account.name)).not.toBeInTheDocument();
    },
  );
  it("실패 후 같은 ID만 재시도하고 표시할 비밀값을 보호한다", async () => {
    let attempts = 0;
    const user = userEvent.setup();
    const api = setup("/access/users/accounts?account_id=usr_one", () => {
      if (++attempts === 1) throw apiFailure("private fixture", 500, "req_account_detail");
      return { accounts: [{ ...account, name: "corp_" + "A".repeat(43) }], total: 1, limit: 1, offset: 0 };
    });
    const panel = within(await screen.findByRole("dialog"));
    await user.click(await panel.findByRole("button", { name: "다시 시도" }));
    expect(await panel.findByText("보호된 값")).toBeVisible();
    expect(details(api).map((call) => (call.options.query as AccountQuery).id)).toEqual([
      account.id,
      account.id,
    ]);
  });
  it("권한 거부 뒤 상세와 목록을 폐기한다", async () => {
    setup("/access/users/accounts?account_id=usr_one", () => {
      throw apiFailure("denied", 403);
    });
    expect(await screen.findByText("사용자 조회 권한을 다시 확인하세요.")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(account.email)).not.toBeInTheDocument();
  });
});
