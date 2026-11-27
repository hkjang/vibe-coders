import { describe, expect, it } from "vitest";

import { donutArcs, foldTail, ringPath } from "./donut-layout";

const geometry = { cx: 100, cy: 100, outer: 80, inner: 50, gap: 2 };

describe("donutArcs", () => {
  it("splits the full turn by share, in order, starting at twelve o'clock", () => {
    const arcs = donutArcs(
      [
        { id: "a", value: 50 },
        { id: "b", value: 25 },
        { id: "c", value: 25 },
      ],
      { ...geometry, gap: 0 },
    );
    expect(arcs.map((arc) => arc.id)).toEqual(["a", "b", "c"]);
    expect(arcs.map((arc) => arc.share)).toEqual([0.5, 0.25, 0.25]);
    expect(arcs[0]?.start).toBeCloseTo(0);
    expect(arcs[0]?.end).toBeCloseTo(Math.PI);
    expect(arcs[2]?.end).toBeCloseTo(Math.PI * 2);
    // Half a turn clockwise from the top puts the middle of the first arc on the right.
    expect(arcs[0]?.centroid.x).toBeCloseTo(165);
    expect(arcs[0]?.centroid.y).toBeCloseTo(100);
  });

  it("leaves a surface gap between neighbours without changing their shares", () => {
    const arcs = donutArcs(
      [
        { id: "a", value: 1 },
        { id: "b", value: 1 },
      ],
      geometry,
    );
    const gapAngle = geometry.gap / geometry.outer;
    expect((arcs[1]?.start ?? 0) - (arcs[0]?.end ?? 0)).toBeCloseTo(gapAngle);
    expect(arcs.map((arc) => arc.share)).toEqual([0.5, 0.5]);
  });

  it("drops empty, negative and non-finite values and draws nothing for an empty total", () => {
    expect(
      donutArcs(
        [
          { id: "a", value: 0 },
          { id: "b", value: -3 },
          { id: "c", value: Number.NaN },
          { id: "d", value: 4 },
        ],
        geometry,
      ).map((arc) => arc.id),
    ).toEqual(["d"]);
    expect(donutArcs([{ id: "a", value: 0 }], geometry)).toEqual([]);
    expect(donutArcs([], geometry)).toEqual([]);
  });

  it("draws a single slice as a closed ring with no gap", () => {
    const [only] = donutArcs([{ id: "a", value: 7 }], geometry);
    expect(only?.share).toBe(1);
    expect(only?.start).toBe(0);
    expect(only?.end).toBeCloseTo(Math.PI * 2);
    expect(only?.path.match(/M/gu)).toHaveLength(2);
    expect(only?.path).not.toContain("NaN");
  });

  it("keeps a sliver visible when it is thinner than the gap", () => {
    const arcs = donutArcs(
      [
        { id: "big", value: 10_000 },
        { id: "sliver", value: 1 },
      ],
      geometry,
    );
    const sliver = arcs[1];
    expect(sliver && sliver.end > sliver.start).toBe(true);
  });
});

describe("ringPath", () => {
  it("uses the large-arc flag past half a turn", () => {
    expect(ringPath(geometry, 0, Math.PI / 2)).toContain("A80 80 0 0 1");
    expect(ringPath(geometry, 0, Math.PI * 1.5)).toContain("A80 80 0 1 1");
  });
});

describe("foldTail", () => {
  const rows = [5, 40, 1, 30, 2, 20].map((value, index) => ({ id: `r${index}`, value }));
  const rest = (folded: readonly { id: string; value: number }[], value: number) => ({
    id: `rest:${folded.length}`,
    value,
  });

  it("returns the items unchanged when they fit", () => {
    expect(foldTail(rows, 6, rest)).toEqual(rows);
  });

  it("keeps the largest in their original order and sums the rest last", () => {
    expect(foldTail(rows, 4, rest)).toEqual([
      { id: "r1", value: 40 },
      { id: "r3", value: 30 },
      { id: "r5", value: 20 },
      { id: "rest:3", value: 8 },
    ]);
  });
});
