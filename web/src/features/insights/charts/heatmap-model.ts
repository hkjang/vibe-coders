// Intensity steps for the table heatmap and bar widths for ranked bars.

export const heatLevels = 4;
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

/** The largest shown value; withheld (null) cells do not set the scale. */
export function heatPeak(values: readonly (number | null | undefined)[]): number {
  let peak = 0;
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > peak) peak = value;
  }
  return peak;
}

/** 0 for nothing or withheld, otherwise 1–4 relative to the busiest cell. */
export function heatLevel(value: number | null | undefined, peak: number): HeatLevel {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || !(peak > 0)) return 0;
  return Math.min(heatLevels, Math.max(1, Math.ceil((value / peak) * heatLevels))) as HeatLevel;
}

/** Width of a ranked bar in percent; anything above zero stays visible. */
export function barPercent(value: number | null | undefined, peak: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || !(peak > 0)) return 0;
  return Math.min(100, Math.max(2, Math.round((value / peak) * 100)));
}
