import { describe, expect, it } from "vitest";
import { sanitizeAppRouteSearch } from "./app-route-query";
import { safeReturnTo } from "@/shared/utils/safe-return-to";

describe("추적 연관 실행 주소", () => {
  it("초기 정리와 로그인 복귀에서 실행 종류 및 페이지를 보존한다", () => {
    const query =
      "?trace_id=public-trace&model=public-model&related_kind=app&related_limit=50&related_offset=100";
    expect(sanitizeAppRouteSearch("/app/observability/traces", query).search).toBe(query);
    expect(safeReturnTo(`/app/observability/traces${query}`)).toBe(`/observability/traces${query}`);
  });
  it.each([
    "related_kind=other",
    "related_kind=app&related_kind=workflow",
    "related_limit=10",
    "related_limit=25&related_limit=25",
    "related_offset=01",
    "related_offset=-1",
    "related_offset=1000001",
  ])("잘못된 조건 %s를 제거한다", (query) => {
    const value = sanitizeAppRouteSearch("/app/observability/traces", `?trace_id=public-trace&${query}`);
    expect(value.search).toBe("?trace_id=public-trace");
    expect(value.rejectedKeys).toHaveLength(1);
  });
  it("다른 화면에 연관 실행 조건을 전달하지 않는다", () => {
    for (const route of ["/app/observability/requests", "/app/overview", "/app/observability/traces/unknown"])
      expect(
        sanitizeAppRouteSearch(route, "?related_kind=app&related_limit=50&related_offset=100").search,
      ).toBe("");
  });
});
