import { describe, expect, it } from "vitest";
import { readAccountPage, validAccountText } from "./account-page-model";
import { accountPageSchema, accountQuerySchema } from "@/shared/api/domains/account-page.schemas";
import { serializeQuery } from "@/shared/api/query";

describe("로그인 계정 서버 조회 상태", () => {
  it("검색·필터·다중 정렬·페이지를 URL에서 서버 조회로 복원한다", () => {
    const state = readAccountPage(
      new URLSearchParams({
        account_q: "개발 %_!",
        account_role: "custom-reviewer",
        account_status: "disabled",
        account_team: "id:team_a",
        account_sort: "role:asc,created_at:desc",
        account_size: "10",
        account_page: "3",
      }),
      [],
    );
    expect(state.query).toEqual({
      view: "accounts",
      q: "개발 %_!",
      role: "custom-reviewer",
      status: "disabled",
      team_id: "team_a",
      sort: "role:asc,created_at:desc",
      limit: 10,
      offset: 20,
    });
  });
  it("팀 미지정 필터는 빈 팀 값을 보존하여 전체 팀 조회와 구분한다", () => {
    const none = readAccountPage(new URLSearchParams("account_team=none"), []);
    expect(none.query.team_id).toBe("");
    expect(serializeQuery(none.query)).toContain("team_id=");
    expect(readAccountPage(new URLSearchParams(), []).query).not.toHaveProperty("team_id");
  });
  it.each([
    "email:asc,email:desc",
    "email:down",
    "password_hash:asc",
    "name:asc,role:asc,status:asc,email:asc",
    "email:asc:extra",
  ])("잘못된 정렬 %s를 전송하지 않는다", (sort) => {
    expect(readAccountPage(new URLSearchParams({ account_sort: sort }), []).query.sort).toBeUndefined();
  });
  it.each(["-1", "1.5", "1000000000", "Infinity", "NaN"])(
    "범위를 벗어난 페이지 %s를 첫 페이지로 복원한다",
    (page) => {
      expect(readAccountPage(new URLSearchParams({ account_page: page }), []).query.offset).toBe(0);
    },
  );
  it("비밀값·제어 문자와 서버 한도를 넘는 필터를 차단한다", () => {
    const secret = "corp_" + "A".repeat(43);
    const state = readAccountPage(
      new URLSearchParams({ account_q: secret, account_role: "a\n", account_team: "id:" + secret }),
      ["corp_"],
    );
    expect(state.query.q).toBeUndefined();
    expect(state.query.team_id).toBeUndefined();
    expect(validAccountText("한".repeat(200), [])).toBe(true);
    expect(validAccountText("한".repeat(201), [])).toBe(false);
    expect(
      accountQuerySchema.safeParse({ view: "accounts", q: "🚀".repeat(200), limit: 25, offset: 0 }).success,
    ).toBe(true);
    expect(
      accountQuerySchema.safeParse({ view: "accounts", q: "🚀".repeat(201), limit: 25, offset: 0 }).success,
    ).toBe(false);
    expect(validAccountText("한".repeat(86), [], 256)).toBe(false);
    expect(validAccountText("a\0b", [])).toBe(false);
  });
  it("응답에서 비밀번호와 추가 필드를 제거하고 누락된 전체 건수를 0으로 바꾸지 않는다", () => {
    const account = {
      id: "usr_1",
      email: "a@example.test",
      name: "계정",
      role: "developer",
      status: "active",
      team_id: "",
      team_name: "",
      created_at: "2026-11-12T00:00:00Z",
      password_hash: "private",
      access_token: "private",
    };
    const result = accountPageSchema.parse({
      accounts: [account],
      total: 1,
      limit: 25,
      offset: 0,
      secret: "private",
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(accountPageSchema.safeParse({ accounts: [], limit: 25, offset: 0 }).success).toBe(false);
  });
});
