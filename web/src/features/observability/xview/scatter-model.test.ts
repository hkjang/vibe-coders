import { describe, expect, it } from "vitest";

import type { ScatterPoint } from "@/shared/api/domains/observability.schemas";

import {
  flowDecisionLabel,
  flowStageLabel,
  flowStatusLabel,
  formatTimeTick,
  nearestPlottedPoint,
  percentile,
  summarizeSelection,
  timeTicks,
  yScale,
} from "./scatter-model";

const point = (overrides: Partial<ScatterPoint>): ScatterPoint =>
  ({
    latency_ms: 0,
    status_code: 200,
    failover: false,
    total_tokens: 0,
    cost_krw: 0,
    ...overrides,
  }) as ScatterPoint;

describe("yScale", () => {
  it("uses round linear ticks, not fractions of the maximum", () => {
    const { ticks } = yScale([1_234], "linear");
    expect(ticks).toEqual([0, 500, 1_000, 1_500]);
  });

  it("spans whole decades on the log axis", () => {
    expect(yScale([3, 2_500], "log").ticks).toEqual([1, 10, 100, 1_000, 10_000]);
  });

  it("does not collapse sub-won costs onto the baseline", () => {
    const { ratio, ticks } = yScale([0.02, 0.4, 3], "log");
    expect(ticks[0]).toBeCloseTo(0.01);
    expect(ratio(0.02)).toBeLessThan(ratio(0.4));
    expect(ratio(0.4)).toBeLessThan(ratio(3));
  });

  it("keeps non-positive values on the baseline and survives empty data", () => {
    const { ratio } = yScale([0, 10, 100], "log");
    expect(ratio(0)).toBeLessThan(ratio(10));
    expect(ratio(-5)).toBe(ratio(0));
    expect(yScale([], "log").ticks).toEqual([1]);
    expect(yScale([], "linear").ticks).toEqual([0]);
    expect(yScale([0, 0], "log").ratio(0)).toBeGreaterThanOrEqual(0);
  });

  it("stays inside the plot for values above the top tick", () => {
    const { ratio } = yScale([10], "linear");
    expect(ratio(1_000)).toBe(1);
  });
});

describe("timeTicks", () => {
  it("aligns to the clock", () => {
    const from = Date.UTC(2026, 10, 5, 7, 21, 13);
    const to = Date.UTC(2026, 10, 5, 7, 46, 2);
    const ticks = timeTicks(from, to);
    expect(ticks.every((tick) => tick % 300_000 === 0)).toBe(true);
    expect(ticks[0]).toBe(Date.UTC(2026, 10, 5, 7, 25));
    expect(ticks.at(-1)).toBe(Date.UTC(2026, 10, 5, 7, 45));
  });

  it("handles an empty or inverted range", () => {
    expect(timeTicks(5, 5)).toEqual([5]);
    expect(timeTicks(5, 1)).toEqual([5]);
  });

  it("formats in the viewer's chosen time zone, with seconds only for short spans", () => {
    const value = Date.UTC(2026, 10, 5, 7, 25, 30);
    expect(formatTimeTick(value, 3_600_000, "Asia/Seoul")).toContain("16:25");
    expect(formatTimeTick(value, 3_600_000, "UTC")).toContain("07:25");
    expect(formatTimeTick(value, 60_000, "UTC")).toContain("30");
  });
});

describe("nearestPlottedPoint", () => {
  const plotted = [
    { point: point({ request_id: "a" }), x: 10, y: 10 },
    { point: point({ request_id: "b" }), x: 40, y: 10 },
    { point: point({ request_id: "c" }), x: 40, y: 10 },
  ];

  it("finds the closest point inside the radius and nothing outside it", () => {
    expect(nearestPlottedPoint(plotted, 12, 11, 12)?.point.request_id).toBe("a");
    expect(nearestPlottedPoint(plotted, 100, 100, 12)).toBeUndefined();
  });

  it("prefers the point drawn on top when they coincide", () => {
    expect(nearestPlottedPoint(plotted, 40, 10, 12)?.point.request_id).toBe("c");
  });
});

describe("summarizeSelection", () => {
  it("summarizes what a selected group did", () => {
    const summary = summarizeSelection([
      point({ latency_ms: 100, total_tokens: 10, cost_krw: 1 }),
      point({ latency_ms: 300, status_code: 500, total_tokens: 20, cost_krw: 2 }),
      point({ latency_ms: 200, failover: true, total_tokens: 30, cost_krw: 3 }),
    ]);
    expect(summary).toEqual({
      count: 3,
      errors: 1,
      fallbacks: 1,
      p50: 200,
      p95: 300,
      totalTokens: 60,
      totalCost: 6,
    });
  });

  it("is zero for an empty selection", () => {
    expect(summarizeSelection([]).p95).toBe(0);
    expect(percentile([], 0.95)).toBe(0);
  });
});

describe("flow labels", () => {
  it("translates known server words and passes the rest through", () => {
    expect(flowStageLabel("upstream")).toBe("업스트림 호출");
    expect(flowStageLabel("custom")).toBe("custom");
    expect(flowStatusLabel("skip")).toBe("해당 없음");
    expect(flowDecisionLabel("allowed")).toBe("허용");
    expect(flowDecisionLabel("openai · gpt-4.1")).toBe("openai · gpt-4.1");
  });
});
