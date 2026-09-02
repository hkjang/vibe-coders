import { describe, expect, it } from "vitest";

import { formatModelDate } from "@/features/gateway/models/model-date";

describe("formatModelDate", () => {
  it("keeps the localized date and time presentation for a normal epoch value", () => {
    const value = 1_700_000_000;
    const expected = new Intl.DateTimeFormat("ko-KR", {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date(value * 1_000));

    expect(formatModelDate(value)).toBe(expected);
  });

  it("formats the inclusive JavaScript Date boundary", () => {
    const boundary = 8_640_000_000_000;
    const expected = new Intl.DateTimeFormat("ko-KR", {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date(boundary * 1_000));

    expect(formatModelDate(boundary)).toBe(expected);
  });

  it("returns the raw integer when an epoch value exceeds the JavaScript Date range", () => {
    expect(formatModelDate(8_640_000_000_001)).toBe("8640000000001");
  });
});
