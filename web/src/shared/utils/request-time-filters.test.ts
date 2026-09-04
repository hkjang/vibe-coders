import { describe, expect, it } from "vitest";

import {
  isValidRequestDateTime,
  isValidRequestTimeZone,
  validateRequestTimeFilters,
} from "@/shared/utils/request-time-filters";

describe("request time filters", () => {
  it.each([
    "2026-09-04",
    "2026-09-04T09:30",
    "2026-09-04 09:30:15",
    "2026-09-04T00:00:00Z",
    "2026-09-04T09:30:15.123456789+09:00",
  ])("accepts a server-compatible date-time: %s", (value) => {
    expect(isValidRequestDateTime(value)).toBe(true);
  });

  it.each([
    "2026-02-30",
    "2026-09-04T25:00",
    "2026-09-04T09:30Z",
    "2026-09-04T09:30:60Z",
    "2026-09-04T09:30:00+24:00",
    "tomorrow",
  ])("rejects a malformed date-time: %s", (value) => {
    expect(isValidRequestDateTime(value)).toBe(false);
  });

  it("accepts known IANA zones and rejects unsupported values", () => {
    expect(isValidRequestTimeZone("Asia/Seoul")).toBe(true);
    expect(isValidRequestTimeZone("UTC")).toBe(true);
    expect(isValidRequestTimeZone("Not/AZone")).toBe(false);
  });

  it("rejects reversed local and offset-aware ranges", () => {
    expect(
      validateRequestTimeFilters({ from: "2026-09-05", to: "2026-09-04", tz: "Asia/Seoul" }),
    ).toMatchObject({ field: "to" });
    expect(
      validateRequestTimeFilters({
        from: "2026-09-04T02:00:00Z",
        to: "2026-09-04T01:00:00Z",
        tz: "UTC",
      }),
    ).toMatchObject({ field: "to" });
    expect(
      validateRequestTimeFilters({
        from: "2026-09-05T00:00",
        to: "2026-09-04T00:00:00Z",
        tz: "Asia/Seoul",
      }),
    ).toMatchObject({ field: "to" });
  });
});
