import { useMemo, useState, type MouseEvent } from "react";

import { ChartEmpty, ChartLegend, ChartTable, PaintDefs, Swatch } from "./chart-parts";
import { paintFill, type CategoryPaint } from "./palette";
import { labelIndexes } from "./scale";
import { stackedArea, type StackedAreaFrame } from "./stacked-area-layout";
import { useChartId } from "./use-chart-id";
import "./charts.css";

export interface StackedSeries {
  id: string;
  label: string;
  paint: CategoryPaint;
  /** One value per bucket; `null` is withheld: drawn as zero height, written as `withheldLabel`. */
  values: readonly (number | null)[];
  selectable?: boolean;
}

interface StackedAreaChartProps {
  caption: string;
  buckets: readonly string[];
  series: readonly StackedSeries[];
  format: (value: number) => string;
  /** Shorter form for the y axis ticks; defaults to `format`. */
  formatAxis?: (value: number) => string;
  /** Formats a bucket key (a date) for the axis and the table. */
  bucketLabel?: (bucket: string) => string;
  onSelect?: (id: string) => void;
  selectHint?: string;
  /** What a withheld value reads as in the tooltip, legend and table. */
  withheldLabel?: string;
}

const frame: StackedAreaFrame = {
  width: 720,
  height: 250,
  padding: { top: 12, right: 14, bottom: 26, left: 60 },
};

/** How a total splits across series over time. One y axis; the legend carries each series' total. */
export function StackedAreaChart({
  caption,
  buckets,
  series,
  format,
  formatAxis = format,
  bucketLabel = (bucket) => bucket,
  onSelect,
  selectHint,
  withheldLabel = "보호됨",
}: StackedAreaChartProps): React.JSX.Element {
  const id = useChartId();
  const [hover, setHover] = useState<number | undefined>(undefined);
  const layout = useMemo(
    () =>
      stackedArea(
        series.map((item) => ({ id: item.id, values: item.values })),
        buckets.length,
        frame,
      ),
    [series, buckets.length],
  );
  if (buckets.length === 0 || series.length === 0) {
    return <ChartEmpty>표시할 추이 데이터가 없습니다.</ChartEmpty>;
  }

  const plotWidth = frame.width - frame.padding.left - frame.padding.right;
  const baseline = frame.height - frame.padding.bottom;
  const track = (event: MouseEvent<SVGSVGElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    const at = ((event.clientX - box.left) / box.width) * frame.width - frame.padding.left;
    const index = buckets.length > 1 ? Math.round((at / plotWidth) * (buckets.length - 1)) : 0;
    setHover(Math.min(buckets.length - 1, Math.max(0, index)));
  };
  const valueText = (value: number | null | undefined): string =>
    value === null ? withheldLabel : format(value ?? 0);
  // A sum over withheld parts is incomplete: say so rather than print a smaller number as the total.
  const sumText = (parts: readonly (number | null | undefined)[]): string => {
    const shown = parts.filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    );
    const sum = shown.reduce((total, value) => total + Math.max(0, value), 0);
    if (!parts.some((value) => value === null)) return format(sum);
    return shown.length === 0 ? withheldLabel : `${format(sum)} (일부 ${withheldLabel})`;
  };
  const seriesTotal = (item: StackedSeries): string => sumText(buckets.map((_, index) => item.values[index]));
  const hoverBucket = hover === undefined ? undefined : buckets[hover];
  const hoverX = hover === undefined ? 0 : buckets.length > 1 ? layout.x(hover) : frame.padding.left;
  const bySeries = new Map(series.map((item) => [item.id, item]));

  return (
    <figure className="wi-viz wi-chart">
      <div className="wi-chart-scroll" tabIndex={0} role="region" aria-label={`${caption} 그래프 영역`}>
        <div className="wi-chart-canvas wi-chart-wide">
          <svg
            viewBox={`0 0 ${frame.width} ${frame.height}`}
            role="img"
            aria-labelledby={`${id}-title`}
            onMouseMove={track}
            onMouseLeave={() => setHover(undefined)}
          >
            <title id={`${id}-title`}>{caption}</title>
            <PaintDefs id={id} paints={series.map((item) => item.paint)} />
            {layout.gridValues.map((value) => (
              <g key={value}>
                <line
                  className="wi-grid-line"
                  x1={frame.padding.left}
                  x2={frame.width - frame.padding.right}
                  y1={layout.y(value)}
                  y2={layout.y(value)}
                />
                <text
                  className="wi-axis-text"
                  x={frame.padding.left - 6}
                  y={layout.y(value) + 4}
                  textAnchor="end"
                >
                  {formatAxis(value)}
                </text>
              </g>
            ))}
            {labelIndexes(buckets.length).map((index, position, shown) => (
              <text
                key={index}
                className="wi-axis-text"
                x={buckets.length > 1 ? layout.x(index) : frame.padding.left}
                y={frame.height - 8}
                textAnchor={position === 0 ? "start" : position === shown.length - 1 ? "end" : "middle"}
              >
                {bucketLabel(buckets[index] ?? "")}
              </text>
            ))}
            {layout.layers.map((layer) => {
              const item = bySeries.get(layer.id);
              if (!item || !layer.path) return null;
              const selectable = Boolean(onSelect) && item.selectable !== false;
              return (
                <g key={layer.id}>
                  <path
                    className="wi-mark"
                    data-selectable={selectable ? "true" : undefined}
                    d={layer.path}
                    style={{
                      fill: paintFill(item.paint, id),
                      fillOpacity: 0.72,
                      stroke: "var(--color-card)",
                      strokeWidth: 1.5,
                    }}
                    onClick={selectable ? () => onSelect?.(layer.id) : undefined}
                  >
                    <title>{`${item.label} · 합계 ${seriesTotal(item)}`}</title>
                  </path>
                </g>
              );
            })}
            {hover !== undefined ? (
              <line
                x1={hoverX}
                x2={hoverX}
                y1={frame.padding.top}
                y2={baseline}
                style={{ stroke: "var(--color-foreground)", strokeWidth: 1, opacity: 0.5 }}
              />
            ) : null}
          </svg>
          {hover !== undefined && hoverBucket !== undefined ? (
            <div
              className="wi-tooltip"
              aria-hidden="true"
              style={
                hoverX > frame.width / 2
                  ? { right: `${100 - (hoverX / frame.width) * 100 + 1.5}%` }
                  : { left: `${(hoverX / frame.width) * 100 + 1.5}%` }
              }
            >
              <strong>{bucketLabel(hoverBucket)}</strong>
              <ul>
                {[...series].reverse().map((item) => (
                  <li key={item.id}>
                    <Swatch paint={item.paint} />
                    <span>{item.label}</span>
                    <span>{valueText(item.values[hover])}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
      <ChartLegend
        label={`${caption} 범례`}
        onSelect={onSelect}
        selectHint={selectHint}
        entries={series.map((item) => ({
          id: item.id,
          label: item.label,
          paint: item.paint,
          value: seriesTotal(item),
          selectable: item.selectable,
        }))}
      />
      <ChartTable
        caption={caption}
        head={["구간", ...series.map((item) => item.label), "합계"]}
        rows={buckets.map((bucket, index) => [
          bucketLabel(bucket),
          ...series.map((item) => valueText(item.values[index])),
          sumText(series.map((item) => item.values[index])),
        ])}
      />
    </figure>
  );
}
