import { describe, expect, it } from "vitest";

import { barPercent, heatLevel, heatPeak } from "./heatmap-model";

describe("heatmap model", () => {
  it("finds the peak among shown values only", () => {
    expect(heatPeak([3, null, 12, undefined, Number.NaN, 7])).toBe(12);
    expect(heatPeak([null, null])).toBe(0);
    expect(heatPeak([])).toBe(0);
  });

  it("maps values to four steps relative to the peak", () => {
    expect(heatLevel(0, 100)).toBe(0);
    expect(heatLevel(1, 100)).toBe(1);
    expect(heatLevel(25, 100)).toBe(1);
    expect(heatLevel(26, 100)).toBe(2);
    expect(heatLevel(75, 100)).toBe(3);
    expect(heatLevel(100, 100)).toBe(4);
    expect(heatLevel(250, 100)).toBe(4);
  });

  it("gives withheld and unusable cells no intensity", () => {
    expect(heatLevel(null, 100)).toBe(0);
    expect(heatLevel(undefined, 100)).toBe(0);
    expect(heatLevel(5, 0)).toBe(0);
    expect(heatLevel(-5, 100)).toBe(0);
  });

  it("keeps a small bar visible and an empty one empty", () => {
    expect(barPercent(100, 100)).toBe(100);
    expect(barPercent(50, 100)).toBe(50);
    expect(barPercent(0.1, 100)).toBe(2);
    expect(barPercent(0, 100)).toBe(0);
    expect(barPercent(null, 100)).toBe(0);
    expect(barPercent(5, 0)).toBe(0);
  });
});
