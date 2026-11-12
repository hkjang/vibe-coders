import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import type { RegisteredTeamQuery } from "@/shared/api/domains/team-page.schemas";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";
import { TeamsTab } from "./TeamsTab";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => ({
      ...testAuth({ role: "admin", scopes: ["admin:read"] }),
      credentialPrefixes: ["corp_"],
    }),
  };
});
const team = {
  id: "team_one",
  name: "플랫폼 팀",
  created_at: "2026-11-12T01:00:00Z",
  updated_at: "2026-11-12T02:00:00Z",
};
function Host() {
  const location = useLocation();
  return (
    <FeatureAccessContext.Provider value={{ featureId: "access.users", permitted: true, readOnly: true }}>
      <output aria-label="현재 주소">{location.search}</output>
      <TeamsTab canWrite={false} writeDeniedReason="조회 전용입니다." />
    </FeatureAccessContext.Provider>
  );
}
function setup(route = "/access/users?tab=teams", detail?: ApiHandler) {
  const api = mockApi({
    "GET /admin/teams": (options, endpoint) => {
      const query = options.query as RegisteredTeamQuery | undefined;
      if (query?.view !== "registered") return { teams: [] };
      if (query.id && detail) return detail(options, endpoint);
      return { auth_teams: [team], total: 1, limit: query.limit, offset: query.offset };
    },
    "GET /admin/teams/scorecard": () => ({ teams: [] }),
    "GET /admin/benchmark/teams": () => ({ teams: [] }),
  });
  renderScreen(<Host />, { route });
  return api;
}
const detailCalls = (api: ReturnType<typeof mockApi>) =>
  api.calls.filter((call) => (call.options.query as RegisteredTeamQuery | undefined)?.id !== undefined);

describe("등록 팀 읽기 전용 상세", () => {
  it("변경 권한 없이 링크로 열고 주소·필터·닫기 초점을 보존한다", async () => {
    const user = userEvent.setup();
    const api = setup("/access/users?tab=teams&registered_q=플랫폼&registered_size=10");
    const link = await screen.findByRole("link", { name: "플랫폼 팀 등록 정보 보기" });
    expect(link).toHaveAttribute("href", expect.stringContaining("registered_team=team_one"));
    await user.click(link);
    const panel = within(await screen.findByRole("dialog", { name: "등록 팀 상세" }));
    expect(await panel.findByText("team_one")).toBeVisible();
    expect(panel.getByText("팀 이름")).toBeVisible();
    expect(panel.queryByRole("button", { name: /수정|저장/ })).not.toBeInTheDocument();
    expect(detailCalls(api).at(-1)?.options.query).toEqual({
      view: "registered",
      id: "team_one",
      limit: 1,
      offset: 0,
    });
    expect(screen.getByLabelText("현재 주소")).toHaveTextContent("registered_team=team_one");
    await user.click(panel.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(link).toHaveFocus();
    expect(screen.getByLabelText("현재 주소")).toHaveTextContent("registered_size=10");
    expect(screen.getByLabelText("현재 주소")).not.toHaveTextContent("registered_team");
    expect(api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
  });
  it("긴 한글·예약 문자가 포함된 상세 주소를 그대로 정확히 조회한다", async () => {
    const id = "팀/%_! " + "가".repeat(1024);
    const api = setup(`/access/users?tab=teams&registered_team=${encodeURIComponent(id)}`, ({ query }) => {
      const value = query as RegisteredTeamQuery;
      return {
        auth_teams: [{ ...team, id, name: "주소로 연 팀" }],
        total: 1,
        limit: value.limit,
        offset: value.offset,
      };
    });
    expect(await within(await screen.findByRole("dialog")).findByText("주소로 연 팀")).toBeVisible();
    expect(detailCalls(api)[0]?.options.query).toMatchObject({ id, limit: 1, offset: 0 });
  });
  it.each([
    ["빈 ID", "registered_team="],
    ["중복 ID", "registered_team=one&registered_team=two"],
    ["너무 긴 ID", `registered_team=${"x".repeat(4097)}`],
    ["제어 문자", "registered_team=team%0Aone"],
  ])("잘못된 주소 %s의 상세를 요청하지 않는다", async (_label, query) => {
    const api = setup(`/access/users?tab=teams&${query}`);
    expect(await screen.findByText("팀 상세 주소를 확인하세요.")).toBeVisible();
    await screen.findByText("플랫폼 팀");
    expect(detailCalls(api)).toHaveLength(0);
  });
  it("없거나 범위 밖인 팀을 다른 팀으로 대체하지 않는다", async () => {
    setup("/access/users?tab=teams&registered_team=missing", () => ({
      auth_teams: [],
      total: 0,
      limit: 1,
      offset: 0,
    }));
    const panel = within(await screen.findByRole("dialog"));
    expect(await panel.findByText("조회 가능한 등록 팀이 없습니다.")).toBeVisible();
    expect(panel.queryByText("플랫폼 팀")).not.toBeInTheDocument();
  });
  it("응답의 ID가 다르면 메타데이터를 노출하지 않는다", async () => {
    setup("/access/users?tab=teams&registered_team=team_other");
    const panel = within(await screen.findByRole("dialog"));
    expect(await panel.findByText("등록 팀 상세 조회 실패")).toBeVisible();
    expect(panel.queryByText("플랫폼 팀")).not.toBeInTheDocument();
  });
  it("실패 후 같은 ID만 재시도한다", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const api = setup("/access/users?tab=teams&registered_team=team_one", () => {
      if (++attempts === 1) throw apiFailure("private fixture");
      return { auth_teams: [team], total: 1, limit: 1, offset: 0 };
    });
    const panel = within(await screen.findByRole("dialog"));
    await user.click(await panel.findByRole("button", { name: "다시 시도" }));
    expect(await panel.findByText("플랫폼 팀")).toBeVisible();
    expect(detailCalls(api).map((call) => (call.options.query as RegisteredTeamQuery).id)).toEqual([
      team.id,
      team.id,
    ]);
  });
  it("권한 거부 뒤 상세와 목록을 폐기한다", async () => {
    setup("/access/users?tab=teams&registered_team=team_one", () => {
      throw apiFailure("denied", 403);
    });
    expect(await screen.findByText("팀 조회 권한을 다시 확인하세요.")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("플랫폼 팀")).not.toBeInTheDocument();
  });
});
