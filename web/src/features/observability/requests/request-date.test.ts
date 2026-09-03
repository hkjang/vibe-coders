import { describe, expect, it } from "vitest";

import { formatRequestDate } from "@/features/observability/requests/request-date";

const options = { dateStyle: "medium", timeStyle: "medium" } satisfies Intl.DateTimeFormatOptions;

describe("formatRequestDate", () => {
  it("formats the same instant in the operator-selected timezone", () => {
    const value = "2026-09-03T01:02:03Z";
    const utc = formatRequestDate(value, "UTC", options);
    const seoul = formatRequestDate(value, "Asia/Seoul", options);

    expect(utc).toBe(
      new Intl.DateTimeFormat("ko-KR", { ...options, timeZone: "UTC" }).format(new Date(value)),
    );
    expect(seoul).toBe(
      new Intl.DateTimeFormat("ko-KR", { ...options, timeZone: "Asia/Seoul" }).format(new Date(value)),
    );
    expect(seoul).not.toBe(utc);
  });

  it("uses the same Seoul default as the request API when the timezone is empty", () => {
    const value = "2026-09-03T01:02:03Z";
    expect(formatRequestDate(value, "", options)).toBe(formatRequestDate(value, "Asia/Seoul", options));
  });

  it("fails closed for invalid dates and unsupported timezones", () => {
    expect(formatRequestDate("not-a-date", "UTC", options)).toBe("확인 불가");
    expect(formatRequestDate("2026-09-03T01:02:03Z", "Not/AZone", options)).toBe("확인 불가");
    expect(formatRequestDate("2026-09-03T01:02:03Z", " UTC ", options)).toBe("확인 불가");
  });
});
