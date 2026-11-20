import { describe, expect, it } from "vitest";
import { legacyRequestDetailHref, legacyRequestListDestination } from "./legacy-request-map";
import { legacyRoutes } from "./legacy-route-map";

const request = (id: string, filterable = true) => ({ request_id: id, request_filterable: filterable });
const link = (id: string) => legacyRequestDetailHref(legacyRoutes.requests, request(id), ["corp_"]);

describe("Legacy request detail identity", () => {
  it.each(["public-1", "public 한글%2F+#?", "a".repeat(512)])(
    "preserves the decoded ID %s exactly once",
    (id) => {
      const href = link(id);
      expect(href).toBeDefined();
      const query = href?.split("?")[1];
      expect(new URLSearchParams(query).get("request_id")).toBe(id);
      expect(new URLSearchParams(query).size).toBe(1);
    },
  );
  it.each([
    "",
    " ",
    " leading",
    "trailing ",
    ".",
    "..",
    "diff",
    "io",
    "public/id",
    "public\\id",
    "public\nid",
    "public\u0085id",
    "a".repeat(513),
    "\ud800",
    "vc_sk_abcdefghijk",
    "corp_" + "x".repeat(32),
  ])("does not promote an unsafe or unsupported identity %s", (id) => {
    expect(link(id)).toBeUndefined();
  });
  it("never substitutes an opaque reference for a nonfilterable request ID", () => {
    expect(legacyRequestDetailHref(legacyRoutes.requests, request("[값 비공개]", false), [])).toBeUndefined();
    expect(legacyRequestDetailHref(legacyRoutes.requests, undefined, [])).toBeUndefined();
  });
  it.each([undefined, "/admin#/runtime-requests", "/admin#/requests?model=public", "/admin#/settings"])(
    "does not graft an ID onto an unknown runtime base %s",
    (base) => expect(legacyRequestDetailHref(base, request("public-1"), [])).toBeUndefined(),
  );
});

describe("Legacy request list filters", () => {
  const query = {
    from: "2026-11-19T01:02:03.123456789+05:45",
    to: "2026-11-20",
    tz: "Asia/Kathmandu",
    ip: "2001:0db8::1",
    model: "public %2F+#?",
    language: "한국어",
    limit: 37,
  };
  it("preserves supported text, exact time bounds and nonstandard limits without double encoding", () => {
    const mapped = legacyRequestListDestination(legacyRoutes.requests, query, true, []);
    expect(mapped.notice).toBeUndefined();
    expect(Object.fromEntries(new URLSearchParams(mapped.href?.split("?")[1]))).toEqual(
      Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
    );
  });
  it("does not turn a request-ID list filter into a detail selection", () => {
    const mapped = legacyRequestListDestination(
      legacyRoutes.requests,
      { ...query, request_id: "list-id", status: "500", trace_id: "trace-1", cursor: "opaque" },
      true,
      [],
    );
    const params = new URLSearchParams(mapped.href?.split("?")[1]);
    expect(params.has("request_id")).toBe(false);
    expect(params.has("status")).toBe(false);
    expect(mapped.notice).toContain("요청 ID");
    expect(mapped.notice).toContain("상태");
    expect(mapped.notice).toContain("추적 ID");
    expect(mapped.notice).toContain("페이지 위치");
    expect(mapped.notice).not.toContain("list-id");
    const detail = legacyRequestDetailHref(legacyRoutes.requests, request("selected-id"), [], mapped);
    const selected = new URLSearchParams(detail?.split("?")[1]);
    expect(selected.get("request_id")).toBe("selected-id");
    expect(selected.get("from")).toBe(query.from);
    expect(selected.get("model")).toBe(query.model);
  });
  it.each([undefined, "/admin#/runtime-requests?custom=1"])(
    "does not append filters to an unknown target %s",
    (base) => {
      const mapped = legacyRequestListDestination(base, query, true, []);
      expect(mapped.href).toBe(base);
      if (base) expect(mapped.notice).toContain("시작 시각");
      else expect(mapped.notice).toBeUndefined();
    },
  );
  it("requires an explicit capability on older servers", () => {
    const mapped = legacyRequestListDestination(legacyRoutes.requests, query, false, []);
    expect(mapped.href).toBe(legacyRoutes.requests);
    expect(mapped.notice).toContain("표시 건수");
  });
  it.each(["corp_" + "s".repeat(32), "vc_sk_" + "s".repeat(32), "\ud800", "x\nx"])(
    "omits unsafe values without reflecting them %s",
    (model) => {
      const mapped = legacyRequestListDestination(legacyRoutes.requests, { model, limit: 50 }, true, [
        "corp_",
      ]);
      expect(mapped.href).toBe("/admin#/requests?limit=50");
      expect(mapped.notice).toContain("모델");
      expect(mapped.notice).not.toContain(model);
    },
  );
  it("omits an invalid range as a group instead of changing its timezone or keeping one bound", () => {
    const mapped = legacyRequestListDestination(
      legacyRoutes.requests,
      { from: "2026-11-20", to: "2026-11-19", tz: "UTC", limit: 50 },
      true,
      [],
    );
    expect(mapped.href).toBe("/admin#/requests?limit=50");
    expect(mapped.notice).toContain("시작 시각");
    expect(mapped.notice).toContain("종료 시각");
    expect(mapped.notice).toContain("시간대");
  });
});
