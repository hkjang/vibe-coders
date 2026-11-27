import { useMemo } from "react";

import { BubbleChart } from "@/features/insights/charts/BubbleChart";
import { DonutChart } from "@/features/insights/charts/DonutChart";
import { categoryPaint, levelPaints, restId } from "@/features/insights/charts/palette";
import { RankedBars } from "@/features/insights/charts/RankedBars";
import { StackedAreaChart } from "@/features/insights/charts/StackedAreaChart";
import { Treemap } from "@/features/insights/charts/Treemap";
import type { WorkMetricId } from "@/shared/api/domains/insights-common";
import type { WorkTrend } from "@/shared/api/domains/insights-usage";
import { formatNumber } from "@/shared/utils/format";

import { bucketLabel, rowDisplay, rowSelectable, rowShare } from "../category-format";
import { foldBreakdown, type BreakdownRow } from "../category-view";
import { withheldChartText } from "../usage-labels";
import {
  formatChange,
  formatMetric,
  formatMetricCompact,
  metricLabels,
  metricShortLabels,
  metricValue,
  suppressedLabel,
} from "../usage-metrics";

interface BreakdownProps {
  rows: readonly BreakdownRow[];
  metric: WorkMetricId;
  caption: string;
  onSelect: (id: string) => void;
}

const drillHint = "하위 분류 또는 세션 목록 보기";

/** Share of the level's total as a donut; small categories are summed into "그 외". */
export function CategoryDonut({
  rows,
  metric,
  caption,
  total,
  onSelect,
}: BreakdownProps & { total: number | null }): React.JSX.Element {
  const data = useMemo(
    () =>
      foldBreakdown(rows).map((row) => ({
        id: row.id,
        label: row.label,
        value: row.value ?? 0,
        display: rowDisplay(row, metric),
        paint: row.paint,
        selectable: rowSelectable(row),
        withheld: row.value === null,
      })),
    [rows, metric],
  );
  return (
    <DonutChart
      caption={caption}
      data={data}
      centerValue={total === null ? suppressedLabel : formatMetricCompact(total, metric)}
      centerLabel={`${metricShortLabels[metric]} 합계`}
      valueHeader={metricLabels[metric]}
      onSelect={onSelect}
      selectHint={drillHint}
      withheldLabel={suppressedLabel}
    />
  );
}

export function CategoryTreemap({ rows, metric, caption, onSelect }: BreakdownProps): React.JSX.Element {
  const data = useMemo(
    () =>
      rows.map((row) => ({
        id: row.id,
        label: row.label,
        value: row.value ?? 0,
        display: rowDisplay(row, metric),
        detail: rowShare(row),
        paint: row.paint,
        selectable: rowSelectable(row),
      })),
    [rows, metric],
  );
  return (
    <Treemap
      caption={caption}
      data={data}
      valueHeader={metricLabels[metric]}
      onSelect={onSelect}
      selectHint={drillHint}
      emptyMessage={rows.some((row) => row.value === null) ? withheldChartText : undefined}
    />
  );
}

export function CategoryBars({
  rows,
  metric,
  caption,
  compare,
  limit,
  onSelect,
}: BreakdownProps & { compare: boolean; limit?: number }): React.JSX.Element {
  const categories = rows.filter((row) => row.kind === "category");
  const shown = [
    ...(limit ? categories.slice(0, limit) : categories),
    ...rows.filter((row) => row.kind !== "category"),
  ];
  return (
    <RankedBars
      label={caption}
      onSelect={onSelect}
      selectHint={drillHint}
      items={shown.map((row) => ({
        id: row.id,
        label: row.label,
        value: row.value,
        display: rowDisplay(row, metric),
        detail: row.suppressed
          ? undefined
          : [rowShare(row), compare && row.kind === "category" ? `직전 대비 ${formatChange(row.change)}` : ""]
              .filter(Boolean)
              .join(" · "),
        paint: row.paint,
        selectable: rowSelectable(row),
      }))}
    />
  );
}

/** x = the selected usage metric, y = cost, area = active users, one bubble per category. */
export function CategoryBubbles({ rows, metric, caption, onSelect }: BreakdownProps): React.JSX.Element {
  // Cost is the y axis, so when cost is the selected metric the x axis falls back to sessions.
  const usage: WorkMetricId = metric === "cost" || metric === "users" ? "sessions" : metric;
  // A withheld category has no position to plot; it is listed as 보호됨 in the table beside it.
  const data = rows.flatMap((row) => {
    const x = metricValue(row.metrics, usage);
    const y = metricValue(row.metrics, "cost");
    if (row.kind !== "category" || row.suppressed || x === null || y === null) return [];
    return [{ id: row.id, label: row.label, x, y, size: row.metrics.users, paint: row.paint }];
  });
  return (
    <BubbleChart
      caption={caption}
      data={data}
      xLabel={metricLabels[usage]}
      yLabel="비용"
      sizeLabel="활성 사용자"
      formatX={(value) => formatMetricCompact(value, usage)}
      formatY={(value) => formatMetricCompact(value, "cost")}
      formatSize={(value) => (value === null ? suppressedLabel : `${formatNumber(value)}명`)}
      onSelect={onSelect}
      selectHint={drillHint}
      emptyMessage={
        rows.some((row) => row.kind === "category" && row.suppressed) ? withheldChartText : undefined
      }
    />
  );
}

interface TrendAreaProps {
  data: WorkTrend;
  metric: WorkMetricId;
  caption: string;
  onSelect: (id: string) => void;
}

/**
 * One layer per category over time; the categories the server folded (the smaller
 * ones, and those too small over the whole period to show alone) stack on top as
 * "그 외". A withheld bucket is drawn at zero height and written as 보호됨.
 */
export function TrendArea({ data, metric, caption, onSelect }: TrendAreaProps): React.JSX.Element {
  const series = useMemo(() => {
    const ids = data.series.map((item) => item.category.id);
    const paints = levelPaints(
      ids,
      data.series.every((item) => item.category.level <= 1),
    );
    const layers = data.series.map((item) => ({
      id: item.category.id,
      label: item.category.name || item.category.id,
      paint: paints.get(item.category.id) ?? categoryPaint(restId),
      values: item.values,
    }));
    // A withheld bucket of "그 외" keeps the layer, so its table cell can say 보호됨.
    return data.other.some((value) => value === null || value > 0)
      ? [
          ...layers,
          { id: restId, label: "그 외", paint: categoryPaint(restId), values: data.other, selectable: false },
        ]
      : layers;
  }, [data]);
  return (
    <StackedAreaChart
      caption={caption}
      buckets={data.buckets}
      series={series}
      format={(value) => formatMetric(value, metric)}
      formatAxis={(value) => formatMetricCompact(value, metric)}
      bucketLabel={bucketLabel}
      onSelect={onSelect}
      selectHint="이 업무의 하위 분류 또는 세션 보기"
      withheldLabel={suppressedLabel}
    />
  );
}
