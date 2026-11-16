import { useId } from "react";

// Charts are hand-built inline SVG: the console ships no charting library, and the
// legacy admin screens drew the same shapes by hand. Colors come from the domain
// stylesheet's validated categorical slots so both themes stay legible.

export interface ChartPoint {
  /** Human-readable x label (also used in the table view). */
  label: string;
  value: number;
}

export interface ChartSeries {
  id: string;
  name: string;
  /** CSS custom property name holding this series' color. */
  colorVar: string;
  points: ReadonlyArray<ChartPoint>;
}

interface TimeSeriesChartProps {
  caption: string;
  /** Formats a value for the tooltip, axis and table view. */
  format: (value: number) => string;
  height?: number;
  series: ReadonlyArray<ChartSeries>;
  valueLabel: string;
  /** Reference a combined accessible table when the caller supplies one. */
  externalTableId?: string;
  /** Keep axis labels readable on narrow screens, with keyboard scrolling. */
  scrollable?: boolean;
}

const chartWidth = 720;

function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

/**
 * Multi-series line chart with a always-available table view. A single series is
 * direct-labelled by the section title, so no legend box is drawn for it.
 */
export function TimeSeriesChart({
  caption,
  format,
  height = 220,
  series,
  valueLabel,
  externalTableId,
  scrollable = false,
}: TimeSeriesChartProps): React.JSX.Element {
  const titleId = useId();
  const labels = series[0]?.points.map((point) => point.label) ?? [];
  const maximum = niceMax(Math.max(0, ...series.flatMap((item) => item.points.map((point) => point.value))));
  const gridValues = [0, 0.25, 0.5, 0.75, 1].map((ratio) => maximum * ratio);
  const padding = {
    top: 12,
    right: 12,
    bottom: 26,
    left: scrollable
      ? Math.max(56, Math.min(240, Math.max(...gridValues.map((value) => format(value).length)) * 8 + 18))
      : 56,
  };
  const plotWidth = chartWidth - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const stepX = labels.length > 1 ? plotWidth / (labels.length - 1) : 0;
  const x = (index: number): number => padding.left + index * stepX;
  const y = (value: number): number => padding.top + plotHeight - (value / maximum) * plotHeight;

  if (labels.length === 0) {
    return (
      <p role="status" className="obs-meta">
        표시할 시계열 데이터가 없습니다.
      </p>
    );
  }

  return (
    <div className="obs-viz">
      <div
        className={scrollable ? "obs-chart obs-chart-scrollable" : "obs-chart"}
        role={scrollable ? "region" : undefined}
        tabIndex={scrollable ? 0 : undefined}
        aria-label={scrollable ? `${caption} 그래프 영역` : undefined}
      >
        <svg
          viewBox={`0 0 ${chartWidth} ${height}`}
          role="img"
          aria-labelledby={titleId}
          aria-describedby={externalTableId}
          style={{ width: "100%", height: "auto" }}
        >
          <title id={titleId}>{caption}</title>
          {gridValues.map((value) => (
            <g key={value}>
              <line
                className="obs-scatter-grid"
                x1={padding.left}
                x2={chartWidth - padding.right}
                y1={y(value)}
                y2={y(value)}
              />
              <text className="obs-scatter-axis" x={padding.left - 6} y={y(value) + 3} textAnchor="end">
                {format(value)}
              </text>
            </g>
          ))}
          {labels.map((label, index) =>
            index === 0 || index === labels.length - 1 || index === Math.floor(labels.length / 2) ? (
              <text
                key={label + String(index)}
                className="obs-scatter-axis"
                x={x(index)}
                y={height - 8}
                textAnchor={index === 0 ? "start" : index === labels.length - 1 ? "end" : "middle"}
              >
                {label}
              </text>
            ) : null,
          )}
          {series.map((item) => (
            <g key={item.id}>
              <polyline
                fill="none"
                stroke={`var(${item.colorVar})`}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                points={item.points.map((point, index) => `${x(index)},${y(point.value)}`).join(" ")}
              />
              {item.points.map((point, index) => (
                <circle
                  key={`${item.id}-${index}`}
                  cx={x(index)}
                  cy={y(point.value)}
                  r={4}
                  fill={`var(${item.colorVar})`}
                  stroke="var(--color-card)"
                  strokeWidth={2}
                >
                  <title>{`${item.name} · ${point.label} · ${format(point.value)}`}</title>
                </circle>
              ))}
            </g>
          ))}
        </svg>
      </div>
      {series.length > 1 ? (
        <ul className="obs-legend">
          {series.map((item) => (
            <li key={item.id} className="obs-legend-item">
              <span className="obs-legend-swatch" style={{ background: `var(${item.colorVar})` }} />
              {item.name}
            </li>
          ))}
        </ul>
      ) : null}
      {!externalTableId && (
        <details>
          <summary>표로 보기</summary>
          <div className="data-table-scroll" tabIndex={0} aria-label={`${caption} 표 영역`}>
            <table className="data-table">
              <caption className="sr-only">{caption}</caption>
              <thead>
                <tr>
                  <th scope="col">구간</th>
                  {series.map((item) => (
                    <th key={item.id} scope="col">
                      {series.length > 1 ? item.name : valueLabel}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {labels.map((label, index) => (
                  <tr key={label + String(index)}>
                    <th scope="row">{label}</th>
                    {series.map((item) => (
                      <td key={item.id} className="cell-number">
                        {format(item.points[index]?.value ?? 0)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
