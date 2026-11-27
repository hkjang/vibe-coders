import { describe, expect, it } from "vitest";

import {
  changeRate,
  formatChange,
  formatMetric,
  formatMetricCompact,
  formatPointChange,
  formatSigned,
  metricValue,
  suppressedHint,
} from "./usage-metrics";

const metrics = {
  sessions: 120,
  requests: 900,
  users: null,
  tokens: 45_000,
  cost_krw: 12_345,
  mcp_calls: 7,
  suppressed: false,
};

describe("usage metrics", () => {
  it("reads each metric, keeping a withheld user count as null", () => {
    expect(metricValue(metrics, "sessions")).toBe(120);
    expect(metricValue(metrics, "requests")).toBe(900);
    expect(metricValue(metrics, "users")).toBeNull();
    expect(metricValue(metrics, "tokens")).toBe(45_000);
    expect(metricValue(metrics, "cost")).toBe(12_345);
    expect(metricValue(metrics, "mcp_calls")).toBe(7);
  });

  it("reads every metric of a withheld group as null, even if a number slipped through", () => {
    for (const metric of ["sessions", "requests", "users", "tokens", "cost", "mcp_calls"] as const) {
      expect(metricValue({ ...metrics, suppressed: true }, metric)).toBeNull();
    }
  });

  it("formats cost as won and everything else as a count", () => {
    expect(formatMetric(12_345, "cost")).toBe("₩12,345");
    expect(formatMetric(12_345, "tokens")).toBe("12,345");
    expect(formatMetric(null, "users")).toBe("—");
    expect(formatMetricCompact(12_300, "sessions")).toBe("1.2만");
    expect(formatMetricCompact(12_300, "cost")).toBe("₩1.2만");
  });

  it("computes a change rate only when there is a base", () => {
    expect(changeRate(150, 100)).toBe(0.5);
    expect(changeRate(50, 100)).toBe(-0.5);
    expect(changeRate(10, 0)).toBeUndefined();
    expect(changeRate(null, 100)).toBeUndefined();
    expect(changeRate(10, null)).toBeUndefined();
  });

  it("writes the direction as an arrow so it does not depend on colour", () => {
    expect(formatChange(0.123)).toBe("▲ 12.3%");
    expect(formatChange(-0.04)).toBe("▼ 4.0%");
    expect(formatChange(0)).toBe("변화 없음");
    expect(formatChange(null)).toBe("—");
    expect(formatChange(undefined)).toBe("—");
  });

  it("writes signed absolute and percentage-point changes", () => {
    expect(formatSigned(1_234)).toBe("+1,234");
    expect(formatSigned(-56)).toBe("−56");
    expect(formatSigned(0)).toBe("0");
    expect(formatSigned(-500, "cost")).toBe("−₩500");
    expect(formatPointChange(0.92, 0.9)).toBe("+2.0%p");
    expect(formatPointChange(0.88, 0.9)).toBe("−2.0%p");
    expect(formatPointChange(0.9, 0.9)).toBe("변화 없음");
    expect(formatPointChange(0.9, null)).toBe("—");
  });

  it("explains small-group protection with the group size", () => {
    expect(suppressedHint(3)).toContain("3명 미만");
  });
});
