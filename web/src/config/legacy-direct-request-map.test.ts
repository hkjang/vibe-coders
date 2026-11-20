import { describe, expect, it } from "vitest";
import {
  directRequestSelection,
  legacyDirectRequestDestination,
  validDirectRequestID,
} from "./legacy-request-map";
import { legacyRoutes } from "./legacy-route-map";
const destination = (id: string, extended = true) =>
  legacyDirectRequestDestination(legacyRoutes.requests, id, true, extended, ["corp_"]);
describe("original request path identity", () => {
  it.each(["public", " leading ", " ", "한글 +%2F?&#", "a".repeat(4096), "한".repeat(1365) + "x"])(
    "round trips a supported original path target",
    (id) => {
      expect(validDirectRequestID(id, [])).toBe(true);
      const mapped = destination(id);
      expect(mapped.sameRequest).toBe(true);
      const query = mapped.href?.split("?")[1];
      expect(new URLSearchParams(query).get("request_id")).toBe(id);
      expect(new URLSearchParams(query).size).toBe(1);
      expect(directRequestSelection("?" + new URLSearchParams({ request_id: id }), [])).toEqual({
        present: true,
        id,
      });
    },
  );
  it.each([
    "",
    ".",
    "..",
    "diff",
    "io",
    "a/b",
    "a\\b",
    "\n",
    "\u0085",
    "\ud800",
    "a".repeat(4097),
    "한".repeat(1366),
    "corp_" + "x".repeat(32),
  ])("refuses an unsupported original target", (id) => {
    expect(validDirectRequestID(id, ["corp_"])).toBe(false);
    expect(destination(id)).toEqual({ href: legacyRoutes.requests, sameRequest: false });
  });
  it("negotiates long hash return support without changing the path ID limit", () => {
    const id = "한".repeat(1365) + "x";
    expect(destination(id, false)).toEqual({ href: legacyRoutes.requests, sameRequest: false });
    expect(destination(id, true).sameRequest).toBe(true);
    expect(destination("a".repeat(4096), false).sameRequest).toBe(true);
  });
  it.each([
    "?request_id=",
    "?request_id=a&request_id=b",
    "?request_id=%ED%A0%80",
    "?request_id=%zz",
    "?request_id=a%2Fb",
    "?request_id=diff",
  ])("retains an invalid explicit selection without choosing another request", (search) => {
    expect(directRequestSelection(search, [])).toEqual({ present: true, id: "" });
  });
  it("distinguishes no target and retains a literal encoded slash", () => {
    expect(directRequestSelection("?live=off", [])).toEqual({ present: false, id: "" });
    expect(directRequestSelection("?request_id=a%252Fb", [])).toEqual({ present: true, id: "a%2Fb" });
  });
  it("preserves custom destination policy and old server fallback without grafting an ID", () => {
    expect(legacyDirectRequestDestination("/admin#/custom?x=1", "same", true, true, [])).toEqual({
      href: "/admin#/custom?x=1",
      sameRequest: false,
    });
    expect(legacyDirectRequestDestination(legacyRoutes.requests, "same", false, true, []).sameRequest).toBe(
      false,
    );
    expect(
      legacyDirectRequestDestination("https://else.invalid/admin", "same", true, true, []).href,
    ).toBeUndefined();
  });
});
