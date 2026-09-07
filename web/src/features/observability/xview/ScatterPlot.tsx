import { useId, useMemo, useRef, useState } from "react";

import {
  metricValue,
  pointCategory,
  scatterMetrics,
  type ScatterCategory,
  type ScatterMetric,
  type ScatterScale,
  type ScatterViewMode,
} from "@/features/observability/xview/scatter-model";
import type { ScatterPoint } from "@/shared/api/domains/observability.schemas";
import { formatDateTime, formatKRW, formatNumber } from "@/shared/utils/format";

interface ScatterPlotProps {
  metric: ScatterMetric;
  onSelect: (points: ReadonlyArray<ScatterPoint>) => void;
  points: ReadonlyArray<ScatterPoint>;
  scale: ScatterScale;
  viewMode: ScatterViewMode;
}

interface Marker {
  color: string;
  label: string;
  shape: "circle" | "diamond" | "square" | "triangle";
}

const width = 880;
const height = 340;
const padding = { top: 16, right: 16, bottom: 34, left: 64 };

/** Status buckets mirror the legacy XView category colouring. */
const categoryMarkers: Record<ScatterCategory, Marker> = {
  error: { color: "var(--color-danger)", label: "오류", shape: "triangle" },
  fallback: { color: "var(--color-warning)", label: "폴백", shape: "square" },
  governance: { color: "var(--color-info)", label: "정책 신호", shape: "diamond" },
  normal: { color: "var(--obs-series-1)", label: "정상", shape: "circle" },
};

const modelColorVars = ["--obs-series-1", "--obs-series-2", "--obs-series-3"] as const;

/** Row cap for the accessible table alternative; the plot itself holds up to 6,000 points. */
const tableRowCap = 200;

function formatMetric(metric: ScatterMetric, value: number): string {
  if (metric === "cost") return formatKRW(value);
  if (metric === "latency" || metric === "first_chunk") return `${formatNumber(value)}ms`;
  return formatNumber(value);
}

function markerPath(shape: Marker["shape"], cx: number, cy: number, size: number): string {
  const half = size / 2;
  if (shape === "square") return `M${cx - half},${cy - half}h${size}v${size}h${-size}Z`;
  if (shape === "triangle") return `M${cx},${cy - half}L${cx + half},${cy + half}L${cx - half},${cy + half}Z`;
  return `M${cx},${cy - half}L${cx + half},${cy}L${cx},${cy + half}L${cx - half},${cy}Z`;
}

/**
 * Live request scatter drawn as inline SVG. Dragging selects a rectangle of
 * requests; the table below is the keyboard-and-screen-reader equivalent.
 */
export function ScatterPlot({
  metric,
  onSelect,
  points,
  scale,
  viewMode,
}: ScatterPlotProps): React.JSX.Element {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ x1: number; y1: number; x2: number; y2: number }>();

  const bounds = useMemo(() => {
    const times = points
      .map((point) => new Date(point.created_at).getTime())
      .filter((time) => Number.isFinite(time));
    const values = points.map((point) => metricValue(point, metric));
    return {
      minTime: times.length ? Math.min(...times) : 0,
      maxTime: times.length ? Math.max(...times) : 1,
      maxValue: values.length ? Math.max(...values, 1) : 1,
    };
  }, [metric, points]);

  const modelOrder = useMemo(() => {
    const counts = new Map<string, number>();
    for (const point of points) counts.set(point.model, (counts.get(point.model) ?? 0) + 1);
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, modelColorVars.length)
      .map(([model]) => model);
  }, [points]);

  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const timeSpan = Math.max(1, bounds.maxTime - bounds.minTime);

  const toX = (point: ScatterPoint): number => {
    const time = new Date(point.created_at).getTime();
    const ratio = Number.isFinite(time) ? (time - bounds.minTime) / timeSpan : 0;
    return padding.left + ratio * plotWidth;
  };
  const toY = (value: number): number => {
    const ratio =
      scale === "log"
        ? Math.log10(Math.max(1, value)) / Math.log10(Math.max(10, bounds.maxValue))
        : value / bounds.maxValue;
    return padding.top + plotHeight - Math.min(1, Math.max(0, ratio)) * plotHeight;
  };

  const markerFor = (point: ScatterPoint): Marker => {
    if (viewMode === "model") {
      const index = modelOrder.indexOf(point.model);
      return {
        color: `var(${modelColorVars[index] ?? "--obs-series-other"})`,
        label: index >= 0 ? point.model : "기타 모델",
        shape: "circle",
      };
    }
    return categoryMarkers[pointCategory(point)];
  };

  const legend: ReadonlyArray<Marker> =
    viewMode === "model"
      ? [
          ...modelOrder.map((model, index) => ({
            color: `var(${modelColorVars[index] ?? "--obs-series-other"})`,
            label: model || "(미상)",
            shape: "circle" as const,
          })),
          { color: "var(--obs-series-other)", label: "기타 모델", shape: "circle" as const },
        ]
      : Object.values(categoryMarkers);

  const toLocal = (event: React.PointerEvent<SVGSVGElement>): { x: number; y: number } => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return { x: 0, y: 0 };
    return {
      x: ((event.clientX - rect.left) / rect.width) * width,
      y: ((event.clientY - rect.top) / rect.height) * height,
    };
  };

  const finishDrag = (): void => {
    if (!drag) return;
    const left = Math.min(drag.x1, drag.x2);
    const right = Math.max(drag.x1, drag.x2);
    const top = Math.min(drag.y1, drag.y2);
    const bottom = Math.max(drag.y1, drag.y2);
    setDrag(undefined);
    if (right - left < 4 && bottom - top < 4) return;
    onSelect(
      points.filter((point) => {
        const x = toX(point);
        const y = toY(metricValue(point, metric));
        return x >= left && x <= right && y >= top && y <= bottom;
      }),
    );
  };

  return (
    <div className="obs-viz">
      <div className="obs-scatter-shell" data-selecting={drag !== undefined}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-labelledby={titleId}
          style={{ width: "100%", height: "auto", touchAction: "none" }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            const local = toLocal(event);
            event.currentTarget.setPointerCapture(event.pointerId);
            setDrag({ x1: local.x, y1: local.y, x2: local.x, y2: local.y });
          }}
          onPointerMove={(event) => {
            if (!drag) return;
            const local = toLocal(event);
            setDrag((current) => (current ? { ...current, x2: local.x, y2: local.y } : current));
          }}
          onPointerUp={finishDrag}
          onPointerCancel={() => setDrag(undefined)}
        >
          <title id={titleId}>
            시간축 대비 {scatterMetrics.find((item) => item.value === metric)?.label} 분포 산점도
          </title>
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = padding.top + plotHeight - ratio * plotHeight;
            const value =
              scale === "log"
                ? 10 ** (ratio * Math.log10(Math.max(10, bounds.maxValue)))
                : bounds.maxValue * ratio;
            return (
              <g key={ratio}>
                <line
                  className="obs-scatter-grid"
                  x1={padding.left}
                  x2={width - padding.right}
                  y1={y}
                  y2={y}
                />
                <text className="obs-scatter-axis" x={padding.left - 6} y={y + 3} textAnchor="end">
                  {formatMetric(metric, value)}
                </text>
              </g>
            );
          })}
          <text className="obs-scatter-axis" x={padding.left} y={height - 10} textAnchor="start">
            {formatDateTime(bounds.minTime)}
          </text>
          <text className="obs-scatter-axis" x={width - padding.right} y={height - 10} textAnchor="end">
            {formatDateTime(bounds.maxTime)}
          </text>
          {points.map((point, index) => {
            const marker = markerFor(point);
            const cx = toX(point);
            const cy = toY(metricValue(point, metric));
            const label = `${point.model || "(미상)"} · ${formatMetric(metric, metricValue(point, metric))} · ${formatDateTime(point.created_at)}`;
            return marker.shape === "circle" ? (
              <circle
                key={`${point.request_id}-${index}`}
                cx={cx}
                cy={cy}
                r={4}
                fill={marker.color}
                stroke="var(--color-card)"
                strokeWidth={2}
              >
                <title>{label}</title>
              </circle>
            ) : (
              <path
                key={`${point.request_id}-${index}`}
                d={markerPath(marker.shape, cx, cy, 9)}
                fill={marker.color}
                stroke="var(--color-card)"
                strokeWidth={2}
              >
                <title>{label}</title>
              </path>
            );
          })}
          {drag ? (
            <rect
              className="obs-scatter-selection"
              x={Math.min(drag.x1, drag.x2)}
              y={Math.min(drag.y1, drag.y2)}
              width={Math.abs(drag.x2 - drag.x1)}
              height={Math.abs(drag.y2 - drag.y1)}
              fillOpacity={0.25}
            />
          ) : null}
        </svg>
      </div>
      <ul className="obs-legend">
        {legend.map((marker) => (
          <li key={marker.label} className="obs-legend-item">
            <span className="obs-legend-swatch" style={{ background: marker.color }} />
            {marker.label}
          </li>
        ))}
      </ul>
      <details>
        <summary>표로 보기 (최근 {formatNumber(Math.min(points.length, tableRowCap))}건)</summary>
        <div className="data-table-scroll" tabIndex={0} aria-label="요청 분포 표 영역">
          <table className="data-table">
            <caption className="sr-only">
              산점도에 표시된 요청 (최근 {formatNumber(tableRowCap)}건까지)
            </caption>
            <thead>
              <tr>
                <th scope="col">시각</th>
                <th scope="col">요청 ID</th>
                <th scope="col">모델</th>
                <th scope="col">구분</th>
                <th scope="col">지표</th>
              </tr>
            </thead>
            <tbody>
              {points
                .slice(-tableRowCap)
                .reverse()
                .map((item, index) => (
                  <tr key={`${item.request_id}-${index}`}>
                    <th scope="row">{formatDateTime(item.created_at)}</th>
                    <td className="mono truncate">{item.request_id}</td>
                    <td>{item.model || "(미상)"}</td>
                    <td>{markerFor(item).label}</td>
                    <td className="cell-number">{formatMetric(metric, metricValue(item, metric))}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
