import { describe, expect, it } from "vitest";

import { lineRuns } from "./line-layout";
import { stackedArea } from "./stacked-area-layout";

const frame = { width: 220, height: 120, padding: { top: 10, right: 10, bottom: 10, left: 10 } };

describe("stackedArea", () => {
  it("stacks each series on the ones before it", () => {
    const layout = stackedArea(
      [
        { id: "a", values: [10, 20, 30] },
        { id: "b", values: [5, 5, 5] },
      ],
      3,
      frame,
    );
    expect(layout.totals).toEqual([15, 25, 35]);
    expect(layout.layers[0]?.bands).toEqual([
      { lower: 0, upper: 10 },
      { lower: 0, upper: 20 },
      { lower: 0, upper: 30 },
    ]);
    expect(layout.layers[1]?.bands).toEqual([
      { lower: 10, upper: 15 },
      { lower: 20, upper: 25 },
      { lower: 30, upper: 35 },
    ]);
    expect(layout.layers.map((layer) => layer.total)).toEqual([60, 15]);
  });

  it("stacks a withheld (null) value as zero height", () => {
    const layout = stackedArea(
      [
        { id: "a", values: [10, null, 30] },
        { id: "b", values: [null, 5, 5] },
      ],
      3,
      frame,
    );
    expect(layout.totals).toEqual([10, 5, 35]);
    expect(layout.layers[1]?.bands[0]).toEqual({ lower: 10, upper: 10 });
    expect(layout.layers.map((layer) => layer.total)).toEqual([40, 10]);
  });

  it("scales to a rounded maximum with the baseline at the bottom of the plot", () => {
    const layout = stackedArea([{ id: "a", values: [0, 35] }], 2, frame);
    expect(layout.maximum).toBe(50);
    expect(layout.gridValues).toEqual([0, 12.5, 25, 37.5, 50]);
    expect(layout.y(0)).toBe(110);
    expect(layout.y(50)).toBe(10);
    expect(layout.x(0)).toBe(10);
    expect(layout.x(1)).toBe(210);
    // Upper edge left to right, then the lower edge back.
    expect(layout.layers[0]?.path).toBe("M10,110 L210,40 L210,110 L10,110 Z");
    expect(layout.layers[0]?.line).toBe("M10,110 L210,40");
  });

  it("treats missing, negative and non-finite values as zero", () => {
    const layout = stackedArea(
      [
        { id: "a", values: [4, Number.NaN, -3] },
        { id: "b", values: [1] },
      ],
      3,
      frame,
    );
    expect(layout.totals).toEqual([5, 0, 0]);
    expect(layout.layers[1]?.bands[2]).toEqual({ lower: 0, upper: 0 });
    for (const layer of layout.layers) expect(layer.path).not.toContain("NaN");
  });

  it("stretches a single bucket across the plot", () => {
    const layout = stackedArea([{ id: "a", values: [8] }], 1, frame);
    expect(layout.layers[0]?.path).toBe("M10,30 L210,30 L210,110 L10,110 Z");
  });

  it("returns empty paths when there is nothing to draw", () => {
    const layout = stackedArea([{ id: "a", values: [] }], 0, frame);
    expect(layout.layers[0]?.path).toBe("");
    expect(layout.totals).toEqual([]);
    expect(layout.maximum).toBe(1);
  });
});

describe("lineRuns", () => {
  it("breaks the line at a withheld bucket and keeps a missing one", () => {
    expect(lineRuns([1, 2, null, 4, null, null, 7], 7)).toEqual([[0, 1], [3], [6]]);
    expect(lineRuns([null, null], 2)).toEqual([]);
    // A bucket the server left out reads as 0, not as withheld.
    expect(lineRuns([1], 3)).toEqual([[0, 1, 2]]);
  });
});
