import type { WorkMetricId } from "@/shared/api/domains/insights-common";
import { formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";

import type { BreakdownRow } from "./category-view";
import { formatChange, formatMetric, metricLabels, metricValue, suppressedLabel } from "./usage-metrics";

// How a breakdown row is written out, shared by the charts and the table.

export const rowDisplay = (row: BreakdownRow, metric: WorkMetricId): string =>
  row.value === null ? suppressedLabel : formatMetric(row.value, metric);

/** The share of the level; a withheld row's share is withheld too. */
export const rowShare = (row: BreakdownRow): string =>
  row.suppressed ? suppressedLabel : row.share === null ? "—" : formatPercent(row.share);

/**
 * A row leads somewhere unless it is the folded remainder or an empty special row.
 * A withheld unclassified or failed row may well have requests, so it stays open.
 */
export const rowSelectable = (row: BreakdownRow): boolean =>
  row.kind === "category" ||
  ((row.kind === "unclassified" || row.kind === "failed") && (row.value === null || row.value > 0));

/** `2026-11-03` → `11-03`; anything else is shown as the server sent it. */
export const bucketLabel = (bucket: string): string =>
  /^\d{4}-\d{2}-\d{2}/u.test(bucket) ? bucket.slice(5, 10) : bucket;

export interface BreakdownColumn {
  id: string;
  header: string;
  help?: string;
  value: (row: BreakdownRow) => string;
}

/** The numeric columns of the breakdown table: current, previous, change, share, users, cost. */
export function breakdownColumns(metric: WorkMetricId, compare: boolean): BreakdownColumn[] {
  const comparison: BreakdownColumn[] = compare
    ? [
        {
          id: "previous",
          header: "직전 기간",
          value: (row) =>
            row.kind !== "category"
              ? "—"
              : row.previousSuppressed
                ? suppressedLabel
                : formatMetric(row.previous, metric),
        },
        {
          id: "change",
          header: "증감",
          value: (row) =>
            row.kind !== "category"
              ? "—"
              : row.suppressed || row.previousSuppressed
                ? suppressedLabel
                : formatChange(row.change),
        },
      ]
    : [];
  return [
    { id: "value", header: metricLabels[metric], value: (row) => rowDisplay(row, metric) },
    ...comparison,
    { id: "share", header: "비중", value: rowShare },
    {
      id: "users",
      header: "활성 사용자",
      help: "기간 안에 이 업무로 AI를 쓴 고유 사용자 수입니다.",
      value: (row) =>
        row.kind !== "category"
          ? "—"
          : row.suppressed || row.metrics.users === null
            ? suppressedLabel
            : formatNumber(row.metrics.users),
    },
    {
      id: "cost",
      header: "비용",
      value: (row) => {
        const cost = row.suppressed ? null : metricValue(row.metrics, "cost");
        return cost === null ? suppressedLabel : formatKRW(cost);
      },
    },
  ];
}
