// Axis helpers shared by the SVG charts.

/** The next "round" number at or above `value` (1, 2, 2.5, 5 × a power of ten). */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const step = [1, 2, 2.5, 5, 10].find((candidate) => scaled <= candidate + 1e-9) ?? 10;
  return step * magnitude;
}

/** Evenly spaced tick values from 0 to `maximum`, inclusive. */
export function ticks(maximum: number, count = 4): number[] {
  return Array.from({ length: count + 1 }, (_, index) => (maximum * index) / count);
}

/** Indexes of the x labels to print so they do not collide: first, last and evenly between. */
export function labelIndexes(length: number, wanted = 7): number[] {
  if (length <= 0) return [];
  if (length <= wanted) return Array.from({ length }, (_, index) => index);
  const indexes = new Set<number>();
  for (let step = 0; step < wanted; step += 1) indexes.add(Math.round((step * (length - 1)) / (wanted - 1)));
  return [...indexes].sort((left, right) => left - right);
}

export const round2 = (value: number): number => Math.round(value * 100) / 100;
