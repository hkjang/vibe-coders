import { describe, expect, it } from "vitest";
import { dwBoundsLabel, dwPointBounds, readDwDateSelection } from "./dw-date-bounds";
import { sanitizeAppRouteSearch } from "@/shared/security/app-route-query";

describe("DW UTC date bounds", () => {
  it("preserves leap-day and absolute dates outside a moving window", () => {
    expect(readDwDateSelection(new URLSearchParams("since_day=2024-02-29&until_day=2024-03-01"))).toEqual({
      kind: "selected",
      bounds: { since_day: "2024-02-29", until_day: "2024-03-01" },
    });
    expect(dwBoundsLabel({ since_day: "2024-02-29", until_day: "2024-03-01" })).toBe("2024-02-29 (UTC)");
  });
  it.each([
    "since_day=2024-02-29",
    "until_day=2024-03-01",
    "since_day=&until_day=",
    "since_day=2023-02-29&until_day=2023-03-01",
    "since_day=2024-03-01&until_day=2024-03-01",
    "since_day=2024-03-02&until_day=2024-03-01",
    "since_day=2024-01-01&until_day=2024-04-01",
    "since_day=2024-02-01&since_day=2024-02-02&until_day=2024-02-03",
    "since_day=2024-02-01&until_day=2024-02-03&until_day=2024-02-04",
    "since_day=not-a-date&until_day=2024-03-02",
    "since_day=1969-12-31&until_day=1970-01-01",
    "since_day=2149-06-06&until_day=2149-06-08",
  ])("refuses %s without silently broadening after query sanitization", (query) => {
    expect(readDwDateSelection(new URLSearchParams(query))).toEqual({ kind: "invalid" });
    const result = sanitizeAppRouteSearch("/data/warehouse", query);
    expect([...new URLSearchParams(result.search).entries()].sort()).toEqual([
      ["since_day", ""],
      ["until_day", ""],
    ]);
    expect(readDwDateSelection(new URLSearchParams(result.search))).toEqual({ kind: "invalid" });
  });
  it("clips partial weeks and the maximum Date while retaining exclusive end", () => {
    expect(dwPointBounds("2024-02-26", "week", "2024-02-29")).toEqual({
      since_day: "2024-02-29",
      until_day: "2024-03-04",
    });
    expect(dwPointBounds("2149-06-02", "week", "2149-06-02")).toEqual({
      since_day: "2149-06-02",
      until_day: "2149-06-07",
    });
    expect(dwPointBounds("2024-02-29", "day", "2024-03-01")).toBeUndefined();
  });
  it("allows exactly 90 days and protects even empty refusal markers on reload", () => {
    expect(readDwDateSelection(new URLSearchParams("since_day=2024-01-01&until_day=2024-03-31")).kind).toBe(
      "selected",
    );
    expect(sanitizeAppRouteSearch("/data/warehouse", "since_day=&until_day=").search).toBe(
      "?since_day=&until_day=",
    );
    expect(readDwDateSelection(new URLSearchParams()).kind).toBe("none");
  });
});
