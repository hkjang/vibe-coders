import { describe, expect, it } from "vitest";
import { readWorkflowPage, validWorkflowDetailId, validWorkflowSearch } from "./workflow-page-model";
import { workflowPageSchema, workflowDetailSchema } from "@/shared/api/domains/workflow-page.schemas";
import { workflowReadFixture } from "@/test/workflow-fixtures";

describe("워크플로 페이지 주소와 데이터 계약", () => {
  it("잘못된 페이지·크기·정렬은 제한된 기본 조회로 복원한다", () => {
    for (const text of [
      "page=-1&size=100000&sort=steps:desc",
      "page=NaN&sort=name:asc,name:desc",
      "page=999999999&sort=name:asc,id:asc,enabled:desc,created_at:desc",
    ])
      expect(readWorkflowPage(new URLSearchParams(text), []).query).toEqual({
        view: "page",
        limit: 25,
        offset: 0,
      });
  });
  it("검색어의 한글·와일드카드는 보존하고 비밀값·제어 문자·초과 길이는 차단한다", () => {
    expect(validWorkflowSearch("개발 %_!", [])).toBe(true);
    for (const value of ["corp_" + "A".repeat(40), "한".repeat(201), "a\nb", "\ud800"])
      expect(validWorkflowSearch(value, ["corp_"])).toBe(false);
    expect(
      readWorkflowPage(new URLSearchParams({ q: "corp_" + "A".repeat(40) }), ["corp_"]).query.q,
    ).toBeUndefined();
  });
  it("상세 ID는 인코딩 가능한 정확한 값과 바이트 상한을 사용한다", () => {
    for (const value of [" wf /?&# ", "한".repeat(1365), "x".repeat(4096)])
      expect(validWorkflowDetailId(value, [])).toBe(true);
    for (const value of ["", "한".repeat(1366), "x".repeat(4097), "\ud800", "id\n", "corp_" + "A".repeat(40)])
      expect(validWorkflowDetailId(value, ["corp_"])).toBe(false);
  });
  it("목록 캐시에 정의·알 수 없는 값을 남기지 않고 상세는 실제 타입을 검증한다", () => {
    const page = workflowReadFixture(
      [{ id: "wf", name: "업무", steps: [{ name: "질문", type: "chat", note: "only-detail" }] }],
      { view: "page" },
    );
    if (!("total" in page) || !page.workflows) throw new Error("fixture page missing");
    const parsed = workflowPageSchema.parse({
      ...page,
      workflows: page.workflows.map((row) => ({ ...row, steps: [{ note: "secret" }], password: "fixture" })),
    });
    expect(JSON.stringify(parsed)).not.toMatch(/secret|password|only-detail/);
    expect(parsed.workflows[0]?.step_count).toBe(1);
    expect(workflowDetailSchema.parse({ workflow: null })).toEqual({ workflow: null });
    expect(workflowDetailSchema.safeParse({ workflow: { id: "wf", steps: "not-an-array" } }).success).toBe(
      false,
    );
    expect(workflowPageSchema.safeParse({ ...page, total: -1 }).success).toBe(false);
  });
});
