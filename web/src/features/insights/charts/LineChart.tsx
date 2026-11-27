import { ChartEmpty, ChartTable } from "./chart-parts";
import { lineRuns } from "./line-layout";
import { labelIndexes, niceMax, round2, ticks } from "./scale";
import { useChartId } from "./use-chart-id";
import "./charts.css";

interface LineChartProps {
  caption: string;
  buckets: readonly string[];
  /** One value per bucket. `null` is a withheld value: a gap in the line, never a 0. */
  values: readonly (number | null)[];
  /** Header of the value column in the table view. */
  valueHeader: string;
  /** CSS custom property holding the line colour. */
  colorVar: string;
  format: (value: number) => string;
  /** Shorter form for the y axis ticks; defaults to `format`. */
  formatAxis?: (value: number) => string;
  bucketLabel?: (bucket: string) => string;
  /** What a withheld value reads as in its tooltip and in the table. */
  withheldLabel?: string;
}

const frame = { width: 720, height: 220, padding: { top: 12, right: 14, bottom: 26, left: 60 } };

/** One series over time with a table view. A withheld bucket is a gap marked on the baseline. */
export function LineChart({
  caption,
  buckets,
  values,
  valueHeader,
  colorVar,
  format,
  formatAxis = format,
  bucketLabel = (bucket) => bucket,
  withheldLabel = "보호됨",
}: LineChartProps): React.JSX.Element {
  const id = useChartId();
  if (buckets.length === 0) return <ChartEmpty>표시할 추이 데이터가 없습니다.</ChartEmpty>;

  // A bucket the server left out reads as 0, as before; only `null` is withheld.
  const valueAt = (index: number): number | null => {
    const value = values[index];
    if (value === null) return null;
    return value !== undefined && Number.isFinite(value) ? value : 0;
  };
  const shown = buckets.map((_, index) => valueAt(index)).filter((value): value is number => value !== null);
  const maximum = niceMax(Math.max(0, ...shown));
  const { width, height, padding } = frame;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const baseline = height - padding.bottom;
  const step = buckets.length > 1 ? plotWidth / (buckets.length - 1) : 0;
  const x = (index: number): number =>
    buckets.length > 1 ? padding.left + index * step : padding.left + plotWidth / 2;
  const y = (value: number): number => padding.top + plotHeight - (Math.max(0, value) / maximum) * plotHeight;
  const text = (index: number): string => {
    const value = valueAt(index);
    return value === null ? withheldLabel : format(value);
  };

  return (
    <figure className="wi-viz wi-chart">
      <div className="wi-chart-scroll" tabIndex={0} role="region" aria-label={`${caption} 그래프 영역`}>
        <div className="wi-chart-canvas wi-chart-wide">
          <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${id}-title`}>
            <title id={`${id}-title`}>{caption}</title>
            {ticks(maximum).map((value) => (
              <g key={value}>
                <line
                  className="wi-grid-line"
                  x1={padding.left}
                  x2={width - padding.right}
                  y1={round2(y(value))}
                  y2={round2(y(value))}
                />
                <text className="wi-axis-text" x={padding.left - 6} y={round2(y(value)) + 4} textAnchor="end">
                  {formatAxis(value)}
                </text>
              </g>
            ))}
            {labelIndexes(buckets.length).map((index, position, labels) => (
              <text
                key={index}
                className="wi-axis-text"
                x={round2(x(index))}
                y={height - 8}
                textAnchor={position === 0 ? "start" : position === labels.length - 1 ? "end" : "middle"}
              >
                {bucketLabel(buckets[index] ?? "")}
              </text>
            ))}
            {lineRuns(values, buckets.length).map((run) => (
              <polyline
                key={run[0]}
                fill="none"
                style={{ stroke: `var(${colorVar})`, strokeWidth: 2 }}
                strokeLinejoin="round"
                strokeLinecap="round"
                points={run.map((index) => `${round2(x(index))},${round2(y(valueAt(index) ?? 0))}`).join(" ")}
              />
            ))}
            {buckets.map((bucket, index) => {
              const value = valueAt(index);
              const title = `${bucketLabel(bucket)} · ${text(index)}`;
              return value === null ? (
                <circle
                  key={bucket}
                  data-withheld="true"
                  cx={round2(x(index))}
                  cy={baseline}
                  r={3}
                  style={{ fill: "var(--color-card)", stroke: "var(--wi-axis)", strokeWidth: 1.5 }}
                >
                  <title>{title}</title>
                </circle>
              ) : (
                <circle
                  key={bucket}
                  cx={round2(x(index))}
                  cy={round2(y(value))}
                  r={4}
                  style={{ fill: `var(${colorVar})`, stroke: "var(--color-card)", strokeWidth: 2 }}
                >
                  <title>{title}</title>
                </circle>
              );
            })}
          </svg>
        </div>
      </div>
      <ChartTable
        caption={caption}
        head={["구간", valueHeader]}
        rows={buckets.map((bucket, index) => [bucketLabel(bucket), text(index)])}
      />
    </figure>
  );
}
