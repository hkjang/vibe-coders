// Pure geometry for the donut chart: no React, no DOM.

export interface DonutInput {
  id: string;
  value: number;
}

export interface DonutArc {
  id: string;
  value: number;
  /** Fraction of the total, 0..1. */
  share: number;
  /** Angles in radians, clockwise from twelve o'clock, after the gap is taken off. */
  start: number;
  end: number;
  path: string;
  /** Centre of the band at the arc's mid-angle: where a marker or label anchors. */
  centroid: { x: number; y: number };
}

export interface DonutGeometry {
  cx: number;
  cy: number;
  outer: number;
  inner: number;
  /** Surface gap between neighbouring arcs, in user units along the outer edge. */
  gap?: number;
}

const fullTurn = Math.PI * 2;

function point(cx: number, cy: number, radius: number, angle: number): { x: number; y: number } {
  return { x: cx + radius * Math.sin(angle), y: cy - radius * Math.cos(angle) };
}

const fixed = (value: number): string => (Math.round(value * 100) / 100).toString();

/** A ring segment between two angles. A full turn is drawn as two halves, which SVG arcs require. */
export function ringPath(geometry: DonutGeometry, start: number, end: number): string {
  const { cx, cy, outer, inner } = geometry;
  if (end - start >= fullTurn - 1e-6) {
    const half = start + Math.PI;
    return `${ringPath(geometry, start, half)} ${ringPath(geometry, half, start + fullTurn - 1e-4)}`;
  }
  const large = end - start > Math.PI ? 1 : 0;
  const a = point(cx, cy, outer, start);
  const b = point(cx, cy, outer, end);
  const c = point(cx, cy, inner, end);
  const d = point(cx, cy, inner, start);
  return [
    `M${fixed(a.x)} ${fixed(a.y)}`,
    `A${fixed(outer)} ${fixed(outer)} 0 ${large} 1 ${fixed(b.x)} ${fixed(b.y)}`,
    `L${fixed(c.x)} ${fixed(c.y)}`,
    `A${fixed(inner)} ${fixed(inner)} 0 ${large} 0 ${fixed(d.x)} ${fixed(d.y)}`,
    "Z",
  ].join(" ");
}

/**
 * One arc per positive value, in the given order. Non-positive and non-finite
 * values take no angle and are left out; the caller still lists them in the legend.
 */
export function donutArcs(items: readonly DonutInput[], geometry: DonutGeometry): DonutArc[] {
  const positive = items.filter((item) => Number.isFinite(item.value) && item.value > 0);
  const total = positive.reduce((sum, item) => sum + item.value, 0);
  if (total <= 0) return [];
  const gapAngle = positive.length > 1 ? (geometry.gap ?? 2) / geometry.outer : 0;
  const middle = (geometry.outer + geometry.inner) / 2;
  let cursor = 0;
  return positive.map((item) => {
    const share = item.value / total;
    const sweep = share * fullTurn;
    // A sliver thinner than the gap keeps a hairline instead of vanishing.
    const inset = Math.min(gapAngle / 2, sweep * 0.25);
    const start = cursor + inset;
    const end = cursor + sweep - inset;
    cursor += sweep;
    return {
      id: item.id,
      value: item.value,
      share,
      start,
      end,
      path: ringPath(geometry, start, end),
      centroid: point(geometry.cx, geometry.cy, middle, (start + end) / 2),
    };
  });
}

/**
 * Keeps the `keep` largest items and sums the rest into one entry, so a donut
 * never carries more slices than a reader can tell apart. Order is preserved.
 */
export function foldTail<Item extends { value: number }>(
  items: readonly Item[],
  keep: number,
  rest: (folded: readonly Item[], value: number) => Item,
): Item[] {
  if (items.length <= keep) return [...items];
  const ranked = [...items].sort((left, right) => right.value - left.value);
  const kept = new Set(ranked.slice(0, Math.max(0, keep - 1)));
  const folded = items.filter((item) => !kept.has(item));
  return [
    ...items.filter((item) => kept.has(item)),
    rest(
      folded,
      folded.reduce((sum, item) => sum + (Number.isFinite(item.value) ? item.value : 0), 0),
    ),
  ];
}
