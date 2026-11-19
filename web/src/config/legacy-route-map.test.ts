import { describe, expect, it } from "vitest";
import { legacyRequestDetailHref, legacyRoutes } from "./legacy-route-map";

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
