import { afterEach, describe, expect, it } from "vitest";
import { sanitizeAppRouteSearch, sanitizeWindowAppLocationBeforeBootstrap } from "./app-route-query";
import {
  appReturnTo,
  safeReturnTo,
  stageSsoReturnTo,
  consumeSsoReturnTo,
} from "@/shared/utils/safe-return-to";

const originalURL = window.location.href;
const originalState: unknown = window.history.state;
const selected = `req_${"a".repeat(22)}.${"b".repeat(21)}`;
afterEach(() => {
  window.history.replaceState(originalState, "", originalURL);
  window.sessionStorage.clear();
});

describe("추적 단계 필터 주소 계약", () => {
  it.each(["all", "tool", "mcp_tool", "text2sql"])(
    "유형 %s와 모든 허용 상태를 선택·목록 조건과 함께 보존한다",
    (kind) => {
      for (const status of ["all", "error", "ok", "unknown", "skipped"]) {
        const search = `?selected_ref=${selected}&status=5xx&flow_kind=${kind}&flow_status=${status}`;
        expect(sanitizeAppRouteSearch("/app/observability/traces", search)).toEqual({
          search,
          rejectedKeys: [],
          sensitiveKeys: [],
        });
        expect(sanitizeAppRouteSearch("/observability/traces", search).search).toBe(search);
      }
    },
  );
  it.each([
    "flow_kind=tool&flow_kind=mcp_tool",
    "flow_status=error&flow_status=error",
    "flow_status=ERROR",
    "flow_kind=request",
    "flow_kind=constructor",
    "flow_status=__proto__",
    "flow_status=",
    `flow_kind=corp_${"x".repeat(32)}`,
  ])("잘못된 조건 %s를 주소에서 제거한다", (query) => {
    const result = sanitizeAppRouteSearch("/app/observability/traces", `?selected_ref=${selected}&${query}`, [
      "corp_",
    ]);
    expect(result.search).toBe(`?selected_ref=${selected}`);
    expect(result.rejectedKeys).toHaveLength(1);
  });
  it("요청 팝업과 다른 화면에는 단계 주소 조건을 허용하지 않는다", () => {
    for (const path of [
      "/app/observability/requests",
      "/app/overview",
      "/app/observability/traces/unknown",
    ]) {
      expect(sanitizeAppRouteSearch(path, "?flow_kind=tool&flow_status=error").search).toBe("");
    }
  });
  it("로그인과 SSO 복귀에서 유효한 필터를 보존한다", () => {
    const route = `/observability/traces?selected_ref=${selected}&flow_kind=text2sql&flow_status=error`;
    expect(safeReturnTo(`/app${route}`)).toBe(route);
    expect(appReturnTo("/observability/traces", route.slice(route.indexOf("?")))).toBe(`/app${route}`);
    expect(stageSsoReturnTo(route)).toBe(`/app${route}`);
    expect(consumeSsoReturnTo()).toBe(`/app${route}`);
  });
  it("초기 부트스트랩에서도 유효한 필터만 유지한다", () => {
    window.history.replaceState(
      null,
      "",
      `/app/observability/traces?selected_ref=${selected}&flow_status=error&flow_kind=private`,
    );
    sanitizeWindowAppLocationBeforeBootstrap();
    expect(window.location.search).toBe(`?selected_ref=${selected}&flow_status=error`);
  });
});
