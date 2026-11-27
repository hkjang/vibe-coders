import {
  categoryPaint,
  failedId,
  levelPaints,
  restId,
  unclassifiedId,
  type CategoryPaint,
} from "@/features/insights/charts/palette";
import type { CategoryRef, WorkMetricId, WorkMetrics } from "@/shared/api/domains/insights-common";
import type { WorkCategories } from "@/shared/api/domains/insights-usage";

import { changeRate, metricValue } from "./usage-metrics";

// Turns one `/categories` response into the rows every breakdown view draws.

export interface BreakdownRow {
  id: string;
  label: string;
  kind: "category" | "unclassified" | "failed" | "rest";
  /** The selected metric; `null` when it is withheld. */
  value: number | null;
  /** The previous period's value; `null` when there is none or it is withheld. */
  previous: number | null;
  /** The previous period exists but is withheld. */
  previousSuppressed: boolean;
  /** Relative change from the previous period; undefined without a base. */
  change: number | undefined;
  /** Share of the level's total, 0..1; `null` when it cannot be stated. */
  share: number | null;
  metrics: WorkMetrics;
  hasChildren: boolean;
  /** The current period is withheld: every measure of the row reads as 보호됨. */
  suppressed: boolean;
  paint: CategoryPaint;
  category?: CategoryRef;
}

function syntheticRow(
  id: string,
  label: string,
  kind: BreakdownRow["kind"],
  metrics: WorkMetrics,
  metric: WorkMetricId,
  total: number | null,
  paint: CategoryPaint,
): BreakdownRow {
  const value = metricValue(metrics, metric);
  return {
    id,
    label,
    kind,
    value,
    previous: null,
    previousSuppressed: false,
    change: undefined,
    share: value !== null && total !== null && total > 0 ? value / total : value === 0 ? 0 : null,
    metrics,
    hasChildren: false,
    // A complementary rule can withhold unclassified or failed so a withheld row cannot be recovered by subtraction.
    suppressed: metrics.suppressed,
    paint,
  };
}

/**
 * Category rows, largest first with withheld rows last, followed by the
 * unclassified and failed rows, which are always present, even at zero.
 */
export function breakdownRows(data: WorkCategories, metric: WorkMetricId): BreakdownRow[] {
  const topLevel = data.parent === null;
  const paints = levelPaints(
    data.rows.map((row) => row.category.id),
    topLevel,
  );
  const total = metricValue(data.total, metric);
  const rows = data.rows.map((row): BreakdownRow => {
    const value = row.suppressed ? null : metricValue(row.current, metric);
    const previous = row.previous ? metricValue(row.previous, metric) : null;
    return {
      id: row.category.id,
      label: row.category.name || row.category.id,
      kind: "category",
      value,
      previous,
      previousSuppressed: row.previous?.suppressed ?? false,
      change: changeRate(value, previous),
      share: row.suppressed ? null : row.share,
      metrics: row.current,
      hasChildren: row.has_children,
      suppressed: row.suppressed,
      paint: paints.get(row.category.id) ?? categoryPaint(restId),
      category: row.category,
    };
  });
  rows.sort((left, right) => (right.value ?? -1) - (left.value ?? -1));
  return [
    ...rows,
    syntheticRow(
      unclassifiedId,
      "미분류",
      "unclassified",
      data.unclassified,
      metric,
      total,
      categoryPaint(unclassifiedId),
    ),
    syntheticRow(failedId, "분류 실패", "failed", data.failed, metric, total, categoryPaint(failedId)),
  ];
}

/**
 * Rows for a share-of-whole picture: the largest categories, the rest summed
 * into one "그 외" slice, then unclassified and failed as their own slices.
 */
export function foldBreakdown(rows: readonly BreakdownRow[], keep = 6): BreakdownRow[] {
  const categories = rows.filter((row) => row.kind === "category");
  const others = rows.filter((row) => row.kind !== "category");
  if (categories.length <= keep + 1) return [...rows];
  const kept = categories.slice(0, keep);
  const folded = categories.slice(keep);
  // Withheld values are skipped; when every folded value is withheld the sum is too.
  const sum = (pick: (row: BreakdownRow) => number | null): number | null => {
    const shown = folded.map(pick).filter((value): value is number => value !== null);
    return shown.length === 0 ? null : shown.reduce((total, value) => total + value, 0);
  };
  const shares = folded.map((row) => row.share);
  const value = sum((row) => row.value);
  const rest: BreakdownRow = {
    id: restId,
    label: `그 외 ${folded.length}개`,
    kind: "rest",
    value,
    previous: null,
    previousSuppressed: false,
    change: undefined,
    share: shares.some((share) => share === null)
      ? null
      : shares.reduce<number>((total, share) => total + (share ?? 0), 0),
    metrics: {
      sessions: sum((row) => metricValue(row.metrics, "sessions")),
      requests: sum((row) => metricValue(row.metrics, "requests")),
      users: null,
      tokens: sum((row) => metricValue(row.metrics, "tokens")),
      cost_krw: sum((row) => metricValue(row.metrics, "cost")),
      mcp_calls: sum((row) => metricValue(row.metrics, "mcp_calls")),
      suppressed: value === null,
    },
    hasChildren: false,
    suppressed: value === null,
    paint: categoryPaint(restId),
  };
  return [...kept, rest, ...others];
}

/** True when the level's total is too small to show: the server sends no rows and withholds the totals. */
export function breakdownWithheld(data: WorkCategories): boolean {
  return data.rows.length === 0 && data.total.suppressed;
}

/** True when a level has nothing at all to show, unclassified and failed included. A withheld group is not empty. */
export function breakdownEmpty(data: WorkCategories): boolean {
  const empty = (metrics: WorkMetrics): boolean =>
    !metrics.suppressed && !metrics.requests && !metrics.sessions;
  return data.rows.length === 0 && empty(data.unclassified) && empty(data.failed) && empty(data.total);
}
