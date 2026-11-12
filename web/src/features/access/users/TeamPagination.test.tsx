import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { TeamsTab } from "./TeamsTab";
import type { RegisteredTeamQuery } from "@/shared/api/domains/team-page.schemas";
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
  id: `team_${index}`,
  name: `등록 팀 ${index}`,
  created_at: "2026-11-12T00:00:00Z",
  updated_at: "2026-11-12T00:00:00Z",
}));
function Host() {
  const location = useLocation();
  return (
    <FeatureAccessContext.Provider value={{ featureId: "access.users", permitted: true, readOnly: false }}>
      <output aria-label="현재 조회 주소">{location.search}</output>
      <TeamsTab canWrite writeDeniedReason="변경 불가" />
    </FeatureAccessContext.Provider>
  );
}
function setup(route = "/access/users?tab=teams", registered?: ApiHandler, usage?: ApiHandler) {
  const api = mockApi({
    "GET /admin/teams": (options, endpoint) => {
      const query = options.query as RegisteredTeamQuery | undefined;
      if (query?.view !== "registered") return usage ? usage(options, endpoint) : { teams: [] };
      if (registered) return registered(options, endpoint);
      return {
        auth_teams: rows.slice(query.offset, query.offset + query.limit),
        total: rows.length,
        limit: query.limit,
        offset: query.offset,
      };
    },
    "GET /admin/teams/scorecard": () => ({ teams: [] }),
    "GET /admin/benchmark/teams": () => ({ teams: [] }),
  });
  const view = renderScreen(<Host />, { route });
  return { api, view };
}
const pageCalls = (api: ReturnType<typeof mockApi>) =>
  api.calls.filter((call) => (call.options.query as { view?: string })?.view === "registered");
describe("등록 팀 서버 페이지", () => {
  it("다음 페이지와 페이지 크기를 서버 조회와 주소에 반영한다", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await screen.findByText("등록 팀 0");
    expect(screen.queryByText("등록 팀 25")).not.toBeInTheDocument();
    expect(screen.getByText(/검색 결과 52개 팀/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "다음" }));
    expect(await screen.findByText("등록 팀 25")).toBeVisible();
    expect(screen.queryByText("등록 팀 0")).not.toBeInTheDocument();
    expect(pageCalls(api).map((call) => call.options.query)).toEqual([
      { view: "registered", limit: 25, offset: 0 },
      { view: "registered", limit: 25, offset: 25 },
    ]);
    expect(screen.getByLabelText("현재 조회 주소")).toHaveTextContent("registered_page=2");
    await user.selectOptions(screen.getByRole("combobox", { name: "페이지당 표시 건수" }), "10");
    await waitFor(() =>
      expect(pageCalls(api).at(-1)?.options.query).toEqual({ view: "registered", limit: 10, offset: 0 }),
    );
  });
  it("공유 주소의 검색과 정렬을 첫 요청에 적용하고 검색을 바꾸면 첫 페이지로 간다", async () => {
    const user = userEvent.setup();
    const { api } = setup(
      "/access/users?tab=teams&registered_q=%25_%21&registered_sort=name:asc,created_at:desc&registered_size=10&registered_page=3",
    );
    await screen.findByText("등록 팀 20");
    expect(pageCalls(api)[0]?.options.query).toEqual({
      view: "registered",
      q: "%_!",
      sort: "name:asc,created_at:desc",
      limit: 10,
      offset: 20,
    });
    const input = screen.getByLabelText("팀 검색");
    expect(input).toHaveValue("%_!");
    await user.clear(input);
    await user.type(input, "개발팀");
    expect(pageCalls(api)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "필터 적용" }));
    await waitFor(() =>
      expect(pageCalls(api).at(-1)?.options.query).toMatchObject({ q: "개발팀", offset: 0 }),
    );
    expect(screen.getByLabelText("현재 조회 주소")).not.toHaveTextContent("registered_page");
  });
  it("비밀 검색값을 주소와 요청에 넣지 않고 오류 입력에 포커스한다", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await screen.findByText("등록 팀 0");
    const input = screen.getByLabelText("팀 검색");
    await user.type(input, "corp_" + "A".repeat(43));
    await user.click(screen.getByRole("button", { name: "필터 적용" }));
    expect(input).toHaveFocus();
    expect(pageCalls(api)).toHaveLength(1);
    expect(screen.getByLabelText("현재 조회 주소")).not.toHaveTextContent("corp_");
    expect(screen.getByRole("alert")).toHaveTextContent("비밀값");
  });
  it("다중 정렬을 세 기준으로 제한한다", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await screen.findByText("등록 팀 0");
    await user.click(screen.getByRole("button", { name: "다중 정렬" }));
    const dialog = within(screen.getByRole("dialog", { name: "다중 정렬 설정" }));
    const add = dialog.getByRole("button", { name: "정렬 기준 추가" });
    await user.click(add);
    await user.click(add);
    await user.click(add);
    expect(add).toBeDisabled();
    await user.click(dialog.getByRole("button", { name: "정렬 적용" }));
    await waitFor(() =>
      expect(pageCalls(api).at(-1)?.options.query).toMatchObject({ sort: "name:asc,id:asc,created_at:asc" }),
    );
  });
  it("등록 팀 오류는 미확인으로 표시하고 정상 사용량을 유지하며 재시도한다", async () => {
    let reads = 0;
    const user = userEvent.setup();
    setup(undefined, ({ query }) => {
      if (++reads === 1) throw apiFailure("private fixture");
      const value = query as RegisteredTeamQuery;
      return { auth_teams: [rows[0]], total: 1, limit: value.limit, offset: value.offset };
    });
    expect(await screen.findByText("등록 팀 목록 조회 실패")).toBeVisible();
    expect(screen.getByText(/등록 팀 수 미확인/)).toBeVisible();
    expect(screen.queryByText(/검색 결과 0개 팀/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("팀 사용량 요약")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("등록 팀 0")).toBeVisible();
  });
  it("사용량 오류는 정상 등록 팀과 변경 작업을 막지 않는다", async () => {
    setup(undefined, undefined, () => {
      throw apiFailure("private usage failure");
    });
    expect(await screen.findByText("등록 팀 0")).toBeVisible();
    expect(screen.getByText("팀 사용량 조회 실패")).toBeVisible();
    expect(screen.getByRole("button", { name: "팀 추가" })).toBeEnabled();
    expect(within(screen.getByLabelText("팀 사용량 요약")).getAllByText("미확인")).toHaveLength(3);
  });
  it.each(["wrong-offset", "wrong-limit", "duplicate", "missing-total", "short-page"])(
    "잘못된 응답 %s는 목록에 표시하지 않는다",
    async (kind) => {
      setup(undefined, ({ query }) => ({
        auth_teams: kind === "duplicate" ? [rows[0], rows[0]] : [rows[0]],
        total:
          kind === "missing-total" ? undefined : kind === "duplicate" ? 2 : kind === "short-page" ? 52 : 1,
        limit: kind === "wrong-limit" ? 10 : (query as RegisteredTeamQuery).limit,
        offset: kind === "wrong-offset" ? 25 : 0,
      }));
      expect(await screen.findByText("등록 팀 목록 조회 실패")).toBeVisible();
      expect(screen.queryByText("등록 팀 0")).not.toBeInTheDocument();
    },
  );
  it("마지막 페이지 밖의 주소에서 존재하는 마지막 페이지로 복구한다", async () => {
    const user = userEvent.setup();
    const { api } = setup("/access/users?tab=teams&registered_page=8");
    await user.click(await screen.findByRole("button", { name: "마지막 페이지로 이동" }));
    expect(await screen.findByText("등록 팀 50")).toBeVisible();
    expect(pageCalls(api).at(-1)?.options.query).toMatchObject({ offset: 50 });
  });
});
