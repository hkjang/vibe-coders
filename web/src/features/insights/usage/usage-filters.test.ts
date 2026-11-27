import { describe, expect, it } from "vitest";

import {
  addDays,
  customRangeUpdates,
  dayToUtc,
  defaultBucket,
  filtersQuery,
  isDefaultFilters,
  narrowingCount,
  oneOf,
  pageIndex,
  periodRange,
  presetUpdates,
  previousRange,
  rangeDays,
  readUsageFilters,
  resetUpdates,
  safeCategoryId,
  safeText,
  seoulToday,
  validCustomRange,
} from "./usage-filters";

const read = (search: string) => readUsageFilters(new URLSearchParams(search));

describe("period helpers", () => {
  it("validates calendar days", () => {
    expect(dayToUtc("2026-11-27")).toBe(Date.UTC(2026, 10, 27));
    expect(dayToUtc("2026-02-30")).toBeUndefined();
    expect(dayToUtc("2026-13-01")).toBeUndefined();
    expect(dayToUtc("20261127")).toBeUndefined();
    expect(dayToUtc("")).toBeUndefined();
  });

  it("adds days across month, year and leap-day boundaries", () => {
    expect(addDays("2026-11-27", -29)).toBe("2026-10-29");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("not-a-day", 3)).toBe("not-a-day");
  });

  it("counts an inclusive range", () => {
    expect(rangeDays({ from: "2026-11-01", to: "2026-11-01" })).toBe(1);
    expect(rangeDays({ from: "2026-11-01", to: "2026-11-30" })).toBe(30);
    expect(rangeDays({ from: "2026-11-30", to: "2026-11-01" })).toBe(0);
    expect(rangeDays({ from: "bad", to: "2026-11-01" })).toBe(0);
  });

  it("takes today from the Seoul calendar, not from UTC", () => {
    // 15:30 UTC is already the next day in Seoul (UTC+9).
    expect(seoulToday(new Date("2026-11-26T15:30:00Z"))).toBe("2026-11-27");
    expect(seoulToday(new Date("2026-11-26T14:59:00Z"))).toBe("2026-11-26");
  });

  it("ends a preset today and spans exactly that many days", () => {
    expect(periodRange({ kind: "preset", days: 7 }, "2026-11-27")).toEqual({
      from: "2026-11-21",
      to: "2026-11-27",
    });
    expect(periodRange({ kind: "preset", days: 30 }, "2026-11-27")).toEqual({
      from: "2026-10-29",
      to: "2026-11-27",
    });
    expect(rangeDays(periodRange({ kind: "preset", days: 90 }, "2026-11-27"))).toBe(90);
    expect(periodRange({ kind: "custom", from: "2026-10-01", to: "2026-10-15" }, "2026-11-27")).toEqual({
      from: "2026-10-01",
      to: "2026-10-15",
    });
  });

  it("puts the previous period right before the current one with the same length", () => {
    expect(previousRange({ from: "2026-11-21", to: "2026-11-27" })).toEqual({
      from: "2026-11-14",
      to: "2026-11-20",
    });
    expect(previousRange({ from: "2026-03-01", to: "2026-03-31" })).toEqual({
      from: "2026-01-29",
      to: "2026-02-28",
    });
    expect(previousRange({ from: "2026-11-27", to: "2026-11-27" })).toEqual({
      from: "2026-11-26",
      to: "2026-11-26",
    });
  });

  it("accepts a custom range only when it is ordered and within retention", () => {
    expect(validCustomRange("2026-11-01", "2026-11-27")).toBe(true);
    expect(validCustomRange("2026-11-27", "2026-11-01")).toBe(false);
    expect(validCustomRange("2026-11-01", "")).toBe(false);
    expect(validCustomRange("2025-01-01", "2026-11-27")).toBe(false);
  });

  it("reads a short period by day and a long one by week", () => {
    expect(defaultBucket({ from: "2026-10-29", to: "2026-11-27" })).toBe("day");
    expect(defaultBucket({ from: "2026-08-30", to: "2026-11-27" })).toBe("week");
  });
});

describe("readUsageFilters", () => {
  it("defaults to 30 days, comparison on and sessions", () => {
    const filters = read("");
    expect(filters).toEqual({
      period: { kind: "preset", days: 30 },
      invalidPeriod: false,
      compare: true,
      team: "",
      category: "",
      action: "",
      model: "",
      client: "",
      metric: "sessions",
    });
    expect(isDefaultFilters(filters)).toBe(true);
    expect(narrowingCount(filters)).toBe(0);
  });

  it("reads every filter from the URL", () => {
    const filters = read(
      "days=7&compare=none&team=%ED%94%8C%EB%9E%AB%ED%8F%BC%ED%8C%80&category=dev.codegen&action=create&model=gpt-4.1&client=Claude%20Code&metric=cost",
    );
    expect(filters).toMatchObject({
      period: { kind: "preset", days: 7 },
      compare: false,
      team: "플랫폼팀",
      category: "dev.codegen",
      action: "create",
      model: "gpt-4.1",
      client: "Claude Code",
      metric: "cost",
    });
    expect(narrowingCount(filters)).toBe(5);
    expect(isDefaultFilters(filters)).toBe(false);
  });

  it("prefers a valid custom range over a preset", () => {
    expect(read("days=7&from=2026-10-01&to=2026-10-15").period).toEqual({
      kind: "custom",
      from: "2026-10-01",
      to: "2026-10-15",
    });
  });

  it("falls back to the preset and says so when the custom range is unusable", () => {
    const filters = read("days=90&from=2026-10-15&to=2026-10-01");
    expect(filters.period).toEqual({ kind: "preset", days: 90 });
    expect(filters.invalidPeriod).toBe(true);
    expect(read("from=2026-10-01").invalidPeriod).toBe(true);
  });

  it("drops values it cannot trust instead of sending them", () => {
    const filters = read(
      `days=14&metric=bogus&action=destroy&category=dev..x&team=${encodeURIComponent("a\u0000b")}&model=${"m".repeat(161)}`,
    );
    expect(filters.period).toEqual({ kind: "preset", days: 30 });
    expect(filters.metric).toBe("sessions");
    expect(filters.action).toBe("");
    expect(filters.category).toBe("");
    expect(filters.team).toBe("");
    expect(filters.model).toBe("");
  });
});

describe("filter serialising", () => {
  it("builds the shared query with an explicit period and without empty filters", () => {
    expect(filtersQuery(read(""), "2026-11-27")).toEqual({
      from: "2026-10-29",
      to: "2026-11-27",
      compare: "prev",
      metric: "sessions",
    });
    expect(
      filtersQuery(read("from=2026-10-01&to=2026-10-15&compare=none&team=ops&metric=tokens"), "2026-11-27"),
    ).toEqual({ from: "2026-10-01", to: "2026-10-15", compare: "none", team: "ops", metric: "tokens" });
  });

  it("writes a preset without the default and clears a custom range", () => {
    expect(presetUpdates(30)).toEqual({ days: undefined, from: undefined, to: undefined, page: undefined });
    expect(presetUpdates(90)).toEqual({ days: 90, from: undefined, to: undefined, page: undefined });
  });

  it("writes a custom range only when it is valid", () => {
    expect(customRangeUpdates("2026-10-01", "2026-10-15")).toEqual({
      days: undefined,
      from: "2026-10-01",
      to: "2026-10-15",
      page: undefined,
    });
    expect(customRangeUpdates("2026-10-15", "2026-10-01")).toBeUndefined();
  });

  it("clears every filter key on reset and nothing else", () => {
    const updates = resetUpdates();
    expect(Object.keys(updates).sort()).toEqual(
      [
        "action",
        "category",
        "client",
        "compare",
        "days",
        "from",
        "metric",
        "model",
        "page",
        "team",
        "to",
      ].sort(),
    );
    expect(Object.values(updates).every((value) => value === undefined)).toBe(true);
    expect("tab" in updates).toBe(false);
  });
});

describe("URL value guards", () => {
  it("picks an allowed value and never passes a missing one through as null", () => {
    expect(oneOf("week", ["day", "week"], "day")).toBe("week");
    expect(oneOf("year", ["day", "week"], "day")).toBe("day");
    expect(oneOf(null, ["day", "week"], "day")).toBe("day");
    // An empty string can itself be an allowed value ("no filter").
    expect(oneOf(null, ["", "review"], "")).toBe("");
    expect(oneOf("", ["", "review"], "review")).toBe("");
  });

  it("bounds free text", () => {
    expect(safeText("  플랫폼팀  ")).toBe("플랫폼팀");
    expect(safeText(null)).toBe("");
    expect(safeText("x".repeat(129))).toBe("");
    expect(safeText("line\nbreak")).toBe("");
  });

  it("accepts dotted slugs only", () => {
    expect(safeCategoryId("dev")).toBe("dev");
    expect(safeCategoryId("dev.code-gen.api_v2")).toBe("dev.code-gen.api_v2");
    expect(safeCategoryId(".dev")).toBe("");
    expect(safeCategoryId("dev.")).toBe("");
    expect(safeCategoryId("dev/../x")).toBe("");
    expect(safeCategoryId("a.b.c.d.e")).toBe("");
  });

  it("reads a 1-based page as a bounded index", () => {
    expect(pageIndex(null, 25)).toBe(0);
    expect(pageIndex("1", 25)).toBe(0);
    expect(pageIndex("4", 25)).toBe(3);
    expect(pageIndex("0", 25)).toBe(0);
    expect(pageIndex("-2", 25)).toBe(0);
    expect(pageIndex("2.5", 25)).toBe(0);
    expect(pageIndex("99999999", 25)).toBe(0);
    // The server refuses an offset above 100,000.
    expect(pageIndex("4001", 25)).toBe(4000);
    expect(pageIndex("4002", 25)).toBe(0);
  });
});
