import { niceMax, ticks } from "./scale";

// Pure geometry for the bubble chart (x = 사용량, y = 비용, r = 활성 사용자): no React, no DOM.

export interface BubbleInput {
  id: string;
  x: number;
  y: number;
  /** The radius measure; `null` when it is withheld (small-group protection) or unknown. */
  size: number | null;
}

export interface BubbleMark {
  id: string;
  cx: number;
  cy: number;
  r: number;
  x: number;
  y: number;
  size: number | null;
  /** False when the radius is the minimum because the size is withheld. */
  sized: boolean;
}

export interface BubbleFrame {
  width: number;
  height: number;
  padding: { top: number; right: number; bottom: number; left: number };
  radius: { min: number; max: number };
}

export interface BubbleLayout {
  /** Largest first, so smaller bubbles paint on top and stay reachable. */
  marks: BubbleMark[];
  xMax: number;
  yMax: number;
  xTicks: number[];
  yTicks: number[];
  x: (value: number) => number;
  y: (value: number) => number;
}

const clean = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

/** Area, not radius, carries the size: r grows with the square root of the value. */
export function bubbleRadius(size: number | null, largest: number, radius: BubbleFrame["radius"]): number {
  if (size === null || !(size > 0) || !(largest > 0)) return radius.min;
  return radius.min + (radius.max - radius.min) * Math.sqrt(Math.min(1, size / largest));
}

export function bubbleLayout(items: readonly BubbleInput[], frame: BubbleFrame): BubbleLayout {
  const plotWidth = frame.width - frame.padding.left - frame.padding.right;
  const plotHeight = frame.height - frame.padding.top - frame.padding.bottom;
  const xMax = niceMax(Math.max(0, ...items.map((item) => clean(item.x))));
  const yMax = niceMax(Math.max(0, ...items.map((item) => clean(item.y))));
  const largest = Math.max(0, ...items.map((item) => (item.size === null ? 0 : clean(item.size))));
  const x = (value: number): number => frame.padding.left + (clean(value) / xMax) * plotWidth;
  const y = (value: number): number => frame.padding.top + plotHeight - (clean(value) / yMax) * plotHeight;
  const marks = items
    .map((item) => ({
      id: item.id,
      cx: x(item.x),
      cy: y(item.y),
      r: bubbleRadius(item.size, largest, frame.radius),
      x: item.x,
      y: item.y,
      size: item.size,
      sized: item.size !== null && item.size > 0,
    }))
    .sort((left, right) => right.r - left.r);
  return { marks, xMax, yMax, xTicks: ticks(xMax), yTicks: ticks(yMax), x, y };
}
