import { describe, expect, it } from "vitest";

import { bubbleLayout, bubbleRadius, type BubbleFrame } from "./bubble-layout";

const frame: BubbleFrame = {
  width: 240,
  height: 140,
  padding: { top: 20, right: 20, bottom: 20, left: 20 },
  radius: { min: 6, max: 26 },
};

describe("bubbleLayout", () => {
  const layout = bubbleLayout(
    [
      { id: "small", x: 50, y: 1_000, size: 4 },
      { id: "large", x: 100, y: 4_000, size: 16 },
      { id: "hidden", x: 0, y: 0, size: null },
    ],
    frame,
  );
  const mark = (id: string) => {
    const found = layout.marks.find((item) => item.id === id);
    if (!found) throw new Error(`missing mark ${id}`);
    return found;
  };

  it("places x and y on linear axes that start at zero", () => {
    expect(layout.xMax).toBe(100);
    expect(layout.yMax).toBe(5_000);
    expect(mark("large")).toMatchObject({ cx: 220, cy: 40 });
    expect(mark("small")).toMatchObject({ cx: 120, cy: 100 });
    expect(mark("hidden")).toMatchObject({ cx: 20, cy: 120 });
    expect(layout.xTicks).toEqual([0, 25, 50, 75, 100]);
  });

  it("scales area, not radius, with the size", () => {
    expect(mark("large").r).toBe(26);
    // A quarter of the largest value is half-way between the radii.
    expect(mark("small").r).toBe(16);
  });

  it("draws a withheld size at the minimum radius and says so", () => {
    expect(mark("hidden")).toMatchObject({ r: 6, sized: false, size: null });
    expect(mark("small").sized).toBe(true);
  });

  it("orders marks largest first so small bubbles stay on top", () => {
    expect(layout.marks.map((item) => item.id)).toEqual(["large", "small", "hidden"]);
  });

  it("survives empty and non-finite input", () => {
    const empty = bubbleLayout([], frame);
    expect(empty.marks).toEqual([]);
    expect(empty.xMax).toBe(1);
    const odd = bubbleLayout([{ id: "odd", x: Number.NaN, y: -5, size: Number.NaN }], frame);
    expect(odd.marks[0]).toMatchObject({ cx: 20, cy: 120, r: 6, sized: false });
  });
});

describe("bubbleRadius", () => {
  it("clamps to the configured radii", () => {
    const radius = { min: 6, max: 26 };
    expect(bubbleRadius(0, 10, radius)).toBe(6);
    expect(bubbleRadius(10, 0, radius)).toBe(6);
    expect(bubbleRadius(50, 10, radius)).toBe(26);
  });
});
