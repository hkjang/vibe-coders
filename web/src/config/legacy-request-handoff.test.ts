import { describe, expect, it } from "vitest";
import { legacyRequestHandoff } from "./legacy-request-handoff";
import { legacyRoutes } from "./legacy-route-map";

const options = {
  base: legacyRoutes.requests,
  requestId: " outside-list 한글 +%2F?&# ",
  detailSupported: true,
  extendedSupported: true,
  filtersSupported: true,
  prefixes: ["corp_"],
  list: { query: { model: "model 한글 +%2F?&#", limit: 30 }, localSearch: false },
};
const params = (href: string | undefined) => new URLSearchParams(href?.split("?")[1]);

describe("request selection with Legacy list filters", () => {
  it("preserves independent original selection and supported predicates exactly once", () => {
    const mapped = legacyRequestHandoff(options);
    expect(Object.fromEntries(params(mapped.href))).toEqual({
      request_id: options.requestId,
      model: options.list.query.model,
      limit: "30",
    });
    expect(mapped.sameRequest).toBe(true);
    expect(mapped.notice).toBeUndefined();
  });
  it("describes omitted filters without substituting a list request ID or disclosing search text", () => {
    const mapped = legacyRequestHandoff({
      ...options,
      list: {
        query: { ...options.list.query, request_id: "predicate-only", status: "error", cursor: "opaque" },
        localSearch: true,
      },
    });
    expect(params(mapped.href).get("request_id")).toBe(options.requestId);
    expect(params(mapped.href).size).toBe(3);
    for (const label of ["요청 ID", "상태", "페이지 위치", "검색 조건", "첫 페이지"]) {
      expect(mapped.notice).toContain(label);
    }
    expect(mapped.notice).not.toMatch(/predicate-only|opaque/u);
  });
  it.each([false, true])("retains a pure long selection through negotiated SSO: extended=%s", (extended) => {
    const id = "한".repeat(1365) + "x";
    const mapped = legacyRequestHandoff({ ...options, requestId: id, extendedSupported: extended });
    expect(mapped.sameRequest).toBe(extended);
    if (extended) {
      expect(Object.fromEntries(params(mapped.href))).toEqual({ request_id: id });
      expect(mapped.notice).toContain("모델");
      expect(mapped.notice).toContain("표시 건수");
    } else {
      expect(params(mapped.href).has("request_id")).toBe(false);
      expect(params(mapped.href).get("model")).toBe(options.list.query.model);
    }
  });
  it("drops only the filters when a combined URL crosses the original SSO hash bound", () => {
    const id = "한".repeat(905);
    const mapped = legacyRequestHandoff({ ...options, requestId: id, extendedSupported: false });
    expect(mapped.sameRequest).toBe(true);
    expect(Object.fromEntries(params(mapped.href))).toEqual({ request_id: id });
    expect(mapped.href).toBeDefined();
    expect(mapped.href?.slice("/admin".length).length).toBeLessThanOrEqual(8192);
    expect(mapped.notice).toContain("모델");
  });
  it.each(["", "diff", "corp_" + "x".repeat(32), "\ud800"])(
    "keeps filters without an invalid selection",
    (id) => {
      const mapped = legacyRequestHandoff({ ...options, requestId: id });
      expect(params(mapped.href).has("request_id")).toBe(false);
      expect(params(mapped.href).get("limit")).toBe("30");
      expect(mapped.sameRequest).toBe(false);
    },
  );
  it("keeps a known selection when an old receiver lacks filter support", () => {
    const mapped = legacyRequestHandoff({ ...options, filtersSupported: false });
    expect(Object.fromEntries(params(mapped.href))).toEqual({ request_id: options.requestId });
    expect(mapped.notice).toContain("모델");
  });
  it("uses a list-only fallback when the receiver lacks detail support", () => {
    const mapped = legacyRequestHandoff({ ...options, detailSupported: false });
    expect(params(mapped.href).has("request_id")).toBe(false);
    expect(params(mapped.href).get("limit")).toBe("30");
    expect(mapped.sameRequest).toBe(false);
  });
  it("leaves custom destinations unchanged and omits all unsupported filters", () => {
    const base = "/admin#/runtime-io?custom=1";
    const mapped = legacyRequestHandoff({ ...options, base });
    expect(mapped.href).toBe(base);
    expect(mapped.sameRequest).toBe(false);
    expect(mapped.notice).toContain("모델");
  });
  it("does not emit a notice or URL when fallback is unavailable", () => {
    expect(legacyRequestHandoff({ ...options, base: undefined })).toEqual({ sameRequest: false });
  });
  it("never sends unsafe filter values alongside an otherwise valid selection", () => {
    const model = "corp_" + "x".repeat(32);
    const mapped = legacyRequestHandoff({
      ...options,
      list: { query: { model, limit: 30 }, localSearch: false },
    });
    expect(params(mapped.href).has("model")).toBe(false);
    expect(params(mapped.href).get("request_id")).toBe(options.requestId);
    expect(mapped.notice).toContain("모델");
    expect(mapped.notice).not.toContain(model);
  });
});
