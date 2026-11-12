import { describe, expect, it } from "vitest";
import { readRegisteredTeamPage, validTeamSearch } from "./registered-team-model";
import { registeredTeamPageSchema, teamUsageSchema } from "@/shared/api/domains/team-page.schemas";

const read = (query = "") => readRegisteredTeamPage(new URLSearchParams(query), ["vc_sk_"]);
const team = {
  id: "team_a",
  name: "개발팀",
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
};
describe("등록 팀 페이지 조건", () => {
  it("기본 조건과 공유한 검색·다중 정렬·페이지를 복원한다", () => {
    expect(read().query).toEqual({ view: "registered", limit: 25, offset: 0 });
    expect(
      read("registered_q=개발&registered_size=10&registered_page=3&registered_sort=name:asc,created_at:desc")
        .query,
    ).toEqual({ view: "registered", q: "개발", limit: 10, offset: 20, sort: "name:asc,created_at:desc" });
  });
  it.each(["0", "-1", "1.5", "Infinity", "40002"])("잘못된 페이지 %s는 첫 페이지로 복원한다", (page) => {
    expect(read(`registered_page=${page}`).query.offset).toBe(0);
  });
  it("최대 범위를 지키고 허용하지 않은 페이지 크기는 기본값을 쓴다", () => {
    expect(read("registered_page=40001").query.offset).toBe(1_000_000);
    expect(read("registered_size=100").query.limit).toBe(25);
  });
  it.each([
    "name:asc,name:desc",
    "name:invalid",
    "unknown:asc",
    "name:asc:extra",
    "name:asc,id:asc,created_at:asc,updated_at:asc",
  ])("지원하지 않는 정렬 %s를 서버로 보내지 않는다", (sort) => {
    expect(read(`registered_sort=${sort}`).query.sort).toBeUndefined();
  });
  it("검색은 유니코드 문자 수를 따르며 비밀값과 제어 문자를 보내지 않는다", () => {
    expect(validTeamSearch("😀".repeat(200), [])).toBe(true);
    expect(validTeamSearch("😀".repeat(201), [])).toBe(false);
    for (const search of ["vc_sk_" + "a".repeat(43), "팀\n이름", "가".repeat(201)]) {
      expect(read(new URLSearchParams({ registered_q: search }).toString()).query.q).toBeUndefined();
    }
    expect(read("registered_q=100%25_").query.q).toBe("100%_");
  });
});
describe("등록 팀 응답 계약", () => {
  const page = { auth_teams: [team], total: 1, limit: 25, offset: 0 };
  it("기존 긴 메타데이터를 보존하고 예상하지 않은 비밀 필드를 버린다", () => {
    const existing = { ...team, id: "x".repeat(1024), name: "가".repeat(16385) };
    const parsed = registeredTeamPageSchema.parse({
      ...page,
      auth_teams: [{ ...existing, secret: "private" }],
      password: "private",
    });
    expect(parsed.auth_teams).toEqual([existing]);
    expect(parsed).not.toHaveProperty("password");
  });
  it.each([
    {},
    { ...page, total: undefined },
    { ...page, total: -1 },
    { ...page, total: 1.1 },
    { ...page, limit: 101 },
    { ...page, offset: 1_000_001 },
    { ...page, auth_teams: null },
    { ...page, auth_teams: Array.from({ length: 101 }, () => team) },
    { ...page, auth_teams: [{ ...team, created_at: "invalid" }] },
  ])("불완전한 응답은 정상 빈 목록이 아니다 (%#)", (data) => {
    expect(registeredTeamPageSchema.safeParse(data).success).toBe(false);
  });
  it("사용량은 정상 빈 목록과 누락된 목록을 구분한다", () => {
    expect(teamUsageSchema.safeParse({ teams: [] }).success).toBe(true);
    expect(teamUsageSchema.safeParse({}).success).toBe(false);
  });
});
