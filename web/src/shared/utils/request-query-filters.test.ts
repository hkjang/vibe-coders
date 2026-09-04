import { describe, expect, it } from "vitest";

import {
  isOpaqueAppRequestCursor,
  isValidRequestQueryField,
  requestQueryFieldError,
} from "@/shared/utils/request-query-filters";

describe("request query filter contract", () => {
  it("accepts bounded values matching the app request endpoint", () => {
    expect(isValidRequestQueryField("model", "한글-모델")).toBe(true);
    expect(isValidRequestQueryField("provider_ref", `prv_${"a".repeat(43)}`)).toBe(true);
    expect(isValidRequestQueryField("status", "503")).toBe(true);
    expect(isValidRequestQueryField("limit", "200")).toBe(true);
    expect(isValidRequestQueryField("ip", "::ffff:192.0.2.10")).toBe(true);
  });

  it("rejects byte overflow, malformed references and unsupported values", () => {
    expect(requestQueryFieldError("model", "한".repeat(86))).toContain("256바이트");
    expect(requestQueryFieldError("language", "한".repeat(22))).toContain("64바이트");
    expect(requestQueryFieldError("cursor", "a".repeat(4_097))).toContain("4,096바이트");
    expect(requestQueryFieldError("provider_ref", "openai")).toContain("형식");
    expect(requestQueryFieldError("status", "599x")).toContain("요청 상태");
    expect(requestQueryFieldError("limit", "201")).toContain("1~200");
  });

  it("rejects whitespace and control characters before URL persistence", () => {
    expect(requestQueryFieldError("request_id", " req-1")).toContain("앞뒤 공백");
    expect(requestQueryFieldError("trace_id", "trace\nprivate")).toContain("제어 문자");
  });

  it("accepts only the encrypted, signed request cursor envelope", () => {
    expect(isOpaqueAppRequestCursor(`djE6dGVzdA.${"s".repeat(43)}`)).toBe(true);
    expect(isOpaqueAppRequestCursor("opaque.cursor")).toBe(false);
    expect(isOpaqueAppRequestCursor(`bm90LXYx.${"s".repeat(43)}`)).toBe(false);
  });
});
