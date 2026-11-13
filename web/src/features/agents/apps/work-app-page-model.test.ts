import { describe, expect, it } from "vitest";
import { readWorkAppPage, validWorkAppDetailId, validWorkAppSearch } from "./work-app-page-model";
import { workAppPageSchema, workAppReadDetailSchema } from "@/shared/api/domains/work-app-page.schemas";
import { workAppReadFixture } from "@/test/work-app-fixtures";

describe("업무 앱 페이지 주소와 데이터 계약", () => {
  it("잘못된 페이지·크기·정렬은 제한된 기본 조회로 복원한다", () => {
    for (const text of [
      "page=-1&size=100000&sort=components:desc",
      "page=NaN&sort=title:asc,title:desc",
      "page=999999999&sort=title:asc,id:asc,status:desc,created_at:desc",
    ])
      expect(readWorkAppPage(new URLSearchParams(text), []).query).toEqual({
        view: "page",
        limit: 25,
        offset: 0,
      });
  });
  it("검색어의 한글·와일드카드는 보존하고 비밀값·제어 문자·초과 길이는 차단한다", () => {
    expect(validWorkAppSearch("개발 %_!", [])).toBe(true);
    for (const value of ["corp_" + "A".repeat(40), "한".repeat(201), "a\nb", "\ud800"])
      expect(validWorkAppSearch(value, ["corp_"])).toBe(false);
    expect(
      readWorkAppPage(new URLSearchParams({ q: "corp_" + "A".repeat(40) }), ["corp_"]).query.q,
    ).toBeUndefined();
  });
  it("상세 ID는 인코딩 가능한 정확한 값과 바이트 상한을 사용한다", () => {
    for (const value of [" wf /?&# ", "한".repeat(1365), "x".repeat(4096)])
      expect(validWorkAppDetailId(value, [])).toBe(true);
    for (const value of ["", "한".repeat(1366), "x".repeat(4097), "\ud800", "id\n", "corp_" + "A".repeat(40)])
      expect(validWorkAppDetailId(value, ["corp_"])).toBe(false);
  });
  it("목록 캐시에 정의·알 수 없는 값을 남기지 않고 상세는 실제 타입을 검증한다", () => {
    const page = workAppReadFixture(
      [{ id: "wf", title: "업무", components: [{ label: "질문", kind: "skill", ref: "only-detail" }] }],
      { view: "page" },
    );
    if (!("total" in page) || !page.apps) throw new Error("fixture page missing");
    const parsed = workAppPageSchema.parse({
      ...page,
      apps: page.apps.map((row) => ({ ...row, components: [{ ref: "secret" }], password: "fixture" })),
    });
    expect(JSON.stringify(parsed)).not.toMatch(/secret|password|only-detail/);
    expect(parsed.apps[0]?.component_count).toBe(1);
    expect(workAppReadDetailSchema.parse({ app: null })).toEqual({ app: null });
    expect(workAppReadDetailSchema.safeParse({ app: { id: "wf", components: "not-an-array" } }).success).toBe(
      false,
    );
    expect(workAppPageSchema.safeParse({ ...page, total: -1 }).success).toBe(false);
  });
});
