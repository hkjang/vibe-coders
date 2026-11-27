// Colour identity for work categories. A top-level category keeps one paint on
// every chart and under every filter: the paint follows the category ID, never
// its rank. Eight validated hues exist (charts.css); categories past the eighth
// reuse a hue with a hatch, so two categories never share a paint by default.
// Colour is never the only encoding: every mark is also labelled or listed.

export interface CategoryPaint {
  /** Stable key; also the suffix of the SVG hatch pattern id. */
  key: string;
  /** CSS custom property that holds the colour in both themes. */
  colorVar: string;
  hatched: boolean;
}

export const hueCount = 8;
/** Solid hues first, then the first three hues again with a hatch. */
export const paintSlotCount = 11;

/** Synthetic rows every breakdown shows next to real categories. */
export const unclassifiedId = "__unclassified";
export const failedId = "__failed";
export const restId = "__rest";

const neutralPaint: CategoryPaint = { key: "neutral", colorVar: "--wi-cat-neutral", hatched: false };
const unclassifiedPaint: CategoryPaint = {
  key: "unclassified",
  colorVar: "--wi-cat-unclassified",
  hatched: true,
};
const failedPaint: CategoryPaint = { key: "failed", colorVar: "--wi-cat-failed", hatched: true };

// The default taxonomy (docs/WORK_INTELLIGENCE_DESIGN.md §4). `other` is the
// catch-all and reads as neutral rather than as a twelfth identity.
const defaultSlots: Readonly<Record<string, number>> = {
  dev: 1,
  infra: 2,
  data: 3,
  office: 4,
  support: 5,
  security: 6,
  planning: 7,
  itsm: 8,
  knowledge: 9,
  ai: 10,
  automation: 11,
};

export function slotPaint(slot: number): CategoryPaint {
  const index = Math.min(Math.max(Math.trunc(slot), 1), paintSlotCount);
  const hatched = index > hueCount;
  const hue = hatched ? index - hueCount : index;
  return { key: `s${index}`, colorVar: `--wi-cat-${hue}`, hatched };
}

function hashSlot(id: string): number {
  let hash = 2_166_136_261;
  for (const character of id) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return ((hash >>> 0) % paintSlotCount) + 1;
}

/** The top-level category of any category ID (`dev.codegen.api` → `dev`). */
export function topCategoryId(id: string): string {
  const dot = id.indexOf(".");
  return dot < 0 ? id : id.slice(0, dot);
}

/** The paint of a top-level category (or of the top-level a deeper ID belongs to). */
export function categoryPaint(id: string): CategoryPaint {
  if (id === unclassifiedId) return unclassifiedPaint;
  if (id === failedId) return failedPaint;
  if (id === restId) return neutralPaint;
  const top = topCategoryId(id);
  if (top === "" || top === "other") return neutralPaint;
  const fixed = Object.hasOwn(defaultSlots, top) ? defaultSlots[top] : undefined;
  return slotPaint(fixed ?? hashSlot(top));
}

/**
 * Paints for the children of one category. They share a top-level category, so
 * they are told apart by their position among their sorted sibling IDs, which a
 * filter or a metric change does not move. Past the available paints the rest
 * read as neutral and rely on their labels.
 */
export function siblingPaints(ids: readonly string[]): ReadonlyMap<string, CategoryPaint> {
  const paints = new Map<string, CategoryPaint>();
  const real = [...new Set(ids)].filter((id) => id !== unclassifiedId && id !== failedId && id !== restId);
  real.sort();
  real.forEach((id, index) => {
    paints.set(id, index < paintSlotCount ? slotPaint(index + 1) : neutralPaint);
  });
  for (const id of [unclassifiedId, failedId, restId]) paints.set(id, categoryPaint(id));
  return paints;
}

/** Paints for one breakdown level: by top-level identity at the root, by sibling below it. */
export function levelPaints(ids: readonly string[], topLevel: boolean): ReadonlyMap<string, CategoryPaint> {
  if (!topLevel) return siblingPaints(ids);
  return new Map(ids.map((id) => [id, categoryPaint(id)]));
}

/** SVG `fill` for a paint; hatched paints reference the pattern `PaintDefs` renders. */
export function paintFill(paint: CategoryPaint, defsId: string): string {
  return paint.hatched ? `url(#${defsId}-${paint.key})` : `var(${paint.colorVar})`;
}
