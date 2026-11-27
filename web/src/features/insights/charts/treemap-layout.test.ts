import { describe, expect, it } from "vitest";

import { squarify, worstRatio } from "./treemap-layout";

const area = (tile: { width: number; height: number }): number => tile.width * tile.height;

describe("squarify", () => {
  it("reproduces the layout of the squarified treemap paper's example", () => {
    // Bruls et al.: areas 6,6,4,3,2,2,1 in a 6×4 rectangle.
    const tiles = squarify(
      [6, 6, 4, 3, 2, 2, 1].map((value, index) => ({ id: `t${index}`, value })),
      6,
      4,
    );
    const [first, second, third, fourth, fifth] = tiles;
    // The first two share a left column 3 wide; the next two a band on top of the rest.
    expect(first).toMatchObject({ x: 0, y: 0, width: 3, height: 2 });
    expect(second).toMatchObject({ x: 0, y: 2, width: 3, height: 2 });
    expect(third?.x).toBeCloseTo(3);
    expect(third?.y).toBeCloseTo(0);
    expect(third?.width).toBeCloseTo(12 / 7);
    expect(third?.height).toBeCloseTo(7 / 3);
    expect(fourth?.x).toBeCloseTo(3 + 12 / 7);
    expect(fourth?.height).toBeCloseTo(7 / 3);
    expect(fifth?.y).toBeCloseTo(7 / 3);
  });

  it("gives each tile an area proportional to its value and fills the rectangle", () => {
    const values = [120, 45, 45, 30, 12, 7, 3, 1];
    const tiles = squarify(
      values.map((value, index) => ({ id: `t${index}`, value })),
      720,
      300,
    );
    const total = values.reduce((sum, value) => sum + value, 0);
    expect(tiles).toHaveLength(values.length);
    for (const tile of tiles) expect(area(tile)).toBeCloseTo((tile.value / total) * 720 * 300, 5);
    expect(tiles.reduce((sum, tile) => sum + area(tile), 0)).toBeCloseTo(720 * 300, 5);
    for (const tile of tiles) {
      expect(tile.x).toBeGreaterThanOrEqual(-1e-9);
      expect(tile.y).toBeGreaterThanOrEqual(-1e-9);
      expect(tile.x + tile.width).toBeLessThanOrEqual(720 + 1e-6);
      expect(tile.y + tile.height).toBeLessThanOrEqual(300 + 1e-6);
    }
  });

  it("does not overlap tiles", () => {
    const tiles = squarify(
      [9, 7, 5, 5, 3, 2, 1, 1].map((value, index) => ({ id: `t${index}`, value })),
      400,
      240,
    );
    for (const [index, a] of tiles.entries()) {
      for (const b of tiles.slice(index + 1)) {
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        expect(overlapX > 1e-6 && overlapY > 1e-6).toBe(false);
      }
    }
  });

  it("orders tiles largest first whatever order the values arrive in", () => {
    const tiles = squarify(
      [
        { id: "small", value: 1 },
        { id: "large", value: 9 },
        { id: "mid", value: 4 },
      ],
      100,
      100,
    );
    expect(tiles.map((tile) => tile.id)).toEqual(["large", "mid", "small"]);
  });

  it("skips values that cannot be drawn and handles degenerate input", () => {
    expect(
      squarify(
        [
          { id: "zero", value: 0 },
          { id: "negative", value: -2 },
          { id: "nan", value: Number.NaN },
          { id: "ok", value: 5 },
        ],
        10,
        10,
      ),
    ).toEqual([{ id: "ok", value: 5, x: 0, y: 0, width: 10, height: 10 }]);
    expect(squarify([], 10, 10)).toEqual([]);
    expect(squarify([{ id: "a", value: 1 }], 0, 10)).toEqual([]);
  });
});

describe("worstRatio", () => {
  it("is 1 for a perfect square and grows as tiles get thinner", () => {
    expect(worstRatio([4], 2)).toBe(1);
    expect(worstRatio([6], 4)).toBeCloseTo(8 / 3);
    expect(worstRatio([6, 6], 4)).toBeCloseTo(1.5);
    expect(worstRatio([], 4)).toBe(Number.POSITIVE_INFINITY);
  });
});
