import { describe, expect, it } from "vitest";

import { labelIndexes, niceMax, ticks } from "./scale";

describe("chart scales", () => {
  it("rounds an axis maximum up to a readable number", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(Number.NaN)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(12)).toBe(20);
    expect(niceMax(21)).toBe(25);
    expect(niceMax(430)).toBe(500);
    expect(niceMax(500)).toBe(500);
    expect(niceMax(0.03)).toBeCloseTo(0.05);
  });

  it("spaces ticks evenly from zero", () => {
    expect(ticks(100)).toEqual([0, 25, 50, 75, 100]);
    expect(ticks(10, 2)).toEqual([0, 5, 10]);
  });

  it("prints every label when they fit and thins them out otherwise", () => {
    expect(labelIndexes(0)).toEqual([]);
    expect(labelIndexes(3)).toEqual([0, 1, 2]);
    expect(labelIndexes(7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(labelIndexes(30)).toEqual([0, 5, 10, 15, 19, 24, 29]);
    expect(labelIndexes(30, 5)).toEqual([0, 7, 15, 22, 29]);
    expect(labelIndexes(2, 5)).toEqual([0, 1]);
  });
});
