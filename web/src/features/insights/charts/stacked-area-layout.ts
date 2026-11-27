import { niceMax, round2, ticks } from "./scale";

// Pure geometry for the stacked area chart: no React, no DOM.

export interface StackedSeriesInput {
  id: string;
  /** `null` is a withheld value: it stacks as zero height. */
  values: readonly (number | null)[];
}

export interface StackedLayer {
  id: string;
  /** Closed area between this layer's lower and upper edge. */
  path: string;
  /** The upper edge only, drawn as the layer's 2px line. */
  line: string;
  /** Per bucket: the lower and upper stacked value. */
  bands: { lower: number; upper: number }[];
  total: number;
}

export interface StackedAreaFrame {
  width: number;
  height: number;
  padding: { top: number; right: number; bottom: number; left: number };
}

export interface StackedAreaLayout {
  layers: StackedLayer[];
  /** Stacked total per bucket. */
  totals: number[];
  maximum: number;
  gridValues: number[];
  x: (index: number) => number;
  y: (value: number) => number;
}

const clean = (value: number | null | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * Stacks the series bottom to top in the given order over `bucketCount` buckets.
 * Missing, withheld (`null`), negative and non-finite values count as zero. A single bucket is
 * drawn as a flat band across the plot so it is still visible.
 */
export function stackedArea(
  series: readonly StackedSeriesInput[],
  bucketCount: number,
  frame: StackedAreaFrame,
): StackedAreaLayout {
  const count = Math.max(0, Math.trunc(bucketCount));
  const plotWidth = frame.width - frame.padding.left - frame.padding.right;
  const plotHeight = frame.height - frame.padding.top - frame.padding.bottom;
  const totals = Array.from({ length: count }, (_, index) =>
    series.reduce((sum, item) => sum + clean(item.values[index]), 0),
  );
  const maximum = niceMax(Math.max(0, ...totals));
  const step = count > 1 ? plotWidth / (count - 1) : 0;
  const x = (index: number): number => frame.padding.left + index * step;
  const y = (value: number): number => frame.padding.top + plotHeight - (value / maximum) * plotHeight;

  const floor = Array.from({ length: count }, () => 0);
  const layers = series.map((item) => {
    const bands = Array.from({ length: count }, (_, index) => {
      const lower = floor[index] ?? 0;
      const upper = lower + clean(item.values[index]);
      floor[index] = upper;
      return { lower, upper };
    });
    // One bucket has no width of its own: stretch it across the plot.
    const columns =
      count === 1
        ? [
            { at: frame.padding.left, band: bands[0] },
            { at: frame.padding.left + plotWidth, band: bands[0] },
          ]
        : bands.map((band, index) => ({ at: x(index), band }));
    const upperEdge = columns.map(({ at, band }) => `${round2(at)},${round2(y(band?.upper ?? 0))}`);
    const lowerEdge = columns.map(({ at, band }) => `${round2(at)},${round2(y(band?.lower ?? 0))}`).reverse();
    return {
      id: item.id,
      path: columns.length ? `M${upperEdge.join(" L")} L${lowerEdge.join(" L")} Z` : "",
      line: columns.length ? `M${upperEdge.join(" L")}` : "",
      bands,
      total: bands.reduce((sum, band) => sum + (band.upper - band.lower), 0),
    };
  });
  return { layers, totals, maximum, gridValues: ticks(maximum), x, y };
}
