import { describe, expect, it } from "vitest";
import { sanitizeAppRouteSearch } from "./app-route-query";
import {
  appReturnTo,
  safeReturnTo,
  stageSsoReturnTo,
  consumeSsoReturnTo,
} from "@/shared/utils/safe-return-to";
import { readTraceTimelineView } from "@/shared/utils/trace-timeline-query";
describe("추적 흐름 표시 주소", () => {
  it.each(["time", "trace"])("표시 %s를 목록 조건과 로그인 복귀에 보존한다", (view) => {
    const search = `?status=5xx&timeline_view=${view}`;
    expect(sanitizeAppRouteSearch("/app/observability/traces", search)).toEqual({
      search,
      rejectedKeys: [],
      sensitiveKeys: [],
    });
    expect(readTraceTimelineView(new URLSearchParams(search))).toBe(view);
    const route = `/observability/traces${search}`;
    expect(safeReturnTo(`/app${route}`)).toBe(route);
    expect(appReturnTo("/observability/traces", search)).toBe(`/app${route}`);
    expect(stageSsoReturnTo(route)).toBe(`/app${route}`);
    expect(consumeSsoReturnTo()).toBe(`/app${route}`);
  });
  it.each(["", "TRACE", "constructor", "__proto__", "trace&timeline_view=trace", "trace&timeline_view=time"])(
    "잘못된 표시 %s를 제거한다",
    (value) => {
      const search = `?timeline_view=${value}`;
      expect(sanitizeAppRouteSearch("/app/observability/traces", search).search).toBe("");
      expect(readTraceTimelineView(new URLSearchParams(search))).toBe("time");
    },
  );
  it.each(["/app/observability/requests", "/app/overview", "/app/observability/traces/unknown"])(
    "다른 경로 %s에는 허용하지 않는다",
    (path) => {
      expect(sanitizeAppRouteSearch(path, "?timeline_view=trace").search).toBe("");
    },
  );
});
