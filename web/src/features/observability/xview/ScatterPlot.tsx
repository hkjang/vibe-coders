import { useId, useMemo, useRef, useState } from "react";

import {
  formatTimeTick,
  metricValue,
  nearestPlottedPoint,
  percentile,
  pointCategory,
  scatterCategories,
  scatterMetrics,
  timeTicks,
  yScale,
  type PlottedPoint,
  type ScatterCategory,
  type ScatterMetric,
  type ScatterScale,
  type ScatterViewMode,
} from "@/features/observability/xview/scatter-model";
import type { ScatterPoint } from "@/shared/api/domains/observability.schemas";
import { Button } from "@/shared/components/ui/Button";
import { formatDateTime, formatDuration, formatKRW, formatNumber } from "@/shared/utils/format";

interface ScatterPlotProps {
  /** Requests whose category is hidden stay in the data but off the plot and out of a drag. */
  hiddenCategories: ReadonlySet<ScatterCategory>;
  metric: ScatterMetric;
  onSelect: (points: ReadonlyArray<ScatterPoint>) => void;
  onToggleCategory: (category: ScatterCategory) => void;
  points: ReadonlyArray<ScatterPoint>;
  scale: ScatterScale;
  /** Fixed horizontal range. A live window slides with it, which is what makes requests flow. */
  timeDomain?: { from: number; to: number } | undefined;
  timeZone: string;
  viewMode: ScatterViewMode;
}

interface Marker {
  color: string;
  label: string;
  shape: "circle" | "diamond" | "square" | "triangle";
}

const width = 880;
const height = 340;
const padding = { top: 16, right: 16, bottom: 28, left: 64 };
const hoverRadius = 12;
const markerSize = 8;
const freshMarkers = 20;
const freshWindowMs = 6_000;

/** Status buckets mirror the legacy XView category colouring. */
const categoryMarkers: Record<ScatterCategory, Marker> = {
  error: { color: "var(--color-danger)", label: "오류", shape: "triangle" },
  fallback: { color: "var(--color-warning)", label: "폴백", shape: "square" },
  governance: { color: "var(--color-info)", label: "정책 신호", shape: "diamond" },
  normal: { color: "var(--obs-series-1)", label: "정상", shape: "circle" },
};

const modelColorVars = ["--obs-series-1", "--obs-series-2", "--obs-series-3"] as const;
const otherModelColor = "var(--obs-series-other)";

/** Row cap for the accessible table alternative; the plot itself holds up to 6,000 points. */
const tableRowCap = 200;

function formatMetric(metric: ScatterMetric, value: number): string {
  if (metric === "cost") return formatKRW(value);
  if (metric === "latency" || metric === "first_chunk") return formatDuration(value);
  return formatNumber(value, value > 0 && value < 1 ? 3 : 0);
}

function markerPath(shape: Marker["shape"], cx: number, cy: number, size: number): string {
  const half = size / 2;
  if (shape === "circle")
    return `M${cx - half},${cy}a${half},${half} 0 1,0 ${size},0a${half},${half} 0 1,0 ${-size},0Z`;
  if (shape === "square") return `M${cx - half},${cy - half}h${size}v${size}h${-size}Z`;
  if (shape === "triangle") return `M${cx},${cy - half}L${cx + half},${cy + half}L${cx - half},${cy + half}Z`;
  return `M${cx},${cy - half}L${cx + half},${cy}L${cx},${cy + half}L${cx - half},${cy}Z`;
}

/**
 * Live request scatter drawn as inline SVG. Every marker of one look shares a single path,
 * so a full 6,000-request window costs a handful of DOM nodes instead of 12,000 and problem
 * categories always paint over normal traffic. Hovering shows a request, clicking opens it,
 * dragging selects a rectangle; the table below is the keyboard-and-screen-reader equivalent.
 */
export function ScatterPlot({
  hiddenCategories,
  metric,
  onSelect,
  onToggleCategory,
  points,
  scale,
  timeDomain,
  timeZone,
  viewMode,
}: ScatterPlotProps): React.JSX.Element {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ x1: number; y1: number; x2: number; y2: number }>();
  const [hover, setHover] = useState<PlottedPoint>();

  const shown = useMemo(
    () =>
      viewMode === "category" && hiddenCategories.size > 0
        ? points.filter((point) => !hiddenCategories.has(pointCategory(point)))
        : points,
    [hiddenCategories, points, viewMode],
  );

  const modelOrder = useMemo(() => {
    const counts = new Map<string, number>();
    for (const point of points) counts.set(point.model, (counts.get(point.model) ?? 0) + 1);
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, modelColorVars.length)
      .map(([model]) => model);
  }, [points]);

  const categoryCounts = useMemo(() => {
    const counts: Record<ScatterCategory, number> = { normal: 0, governance: 0, fallback: 0, error: 0 };
    for (const point of points) counts[pointCategory(point)] += 1;
    return counts;
  }, [points]);

  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const layout = useMemo(() => {
    const times = shown.map((point) => Date.parse(point.created_at)).filter(Number.isFinite);
    const values = shown.map((point) => metricValue(point, metric));
    const first = times.length ? times.reduce((a, b) => Math.min(a, b)) : 0;
    const last = times.length ? times.reduce((a, b) => Math.max(a, b)) : 1;
    const to = timeDomain?.to ?? last;
    // A window much longer than its traffic would squeeze every point into a sliver at the
    // right edge, so the axis starts just before the oldest request it has to show.
    const from =
      timeDomain && times.length
        ? Math.max(timeDomain.from, first - (to - first) * 0.05)
        : (timeDomain?.from ?? first);
    const span = Math.max(1, to - from);
    const axis = yScale(values, scale);
    const toX = (time: number): number =>
      padding.left + Math.min(1, Math.max(0, (time - from) / span)) * plotWidth;
    const toY = (value: number): number => padding.top + plotHeight - axis.ratio(value) * plotHeight;
    const plotted: PlottedPoint[] = shown.map((point) => {
      const time = Date.parse(point.created_at);
      return {
        point,
        x: toX(Number.isFinite(time) ? time : from),
        y: toY(metricValue(point, metric)),
      };
    });
    const sorted = [...values].sort((left, right) => left - right);
    return { axis, from, plotted, span, to, toX, toY, p95: percentile(sorted, 0.95) };
  }, [metric, plotHeight, plotWidth, scale, shown, timeDomain]);

  const markerFor = (point: ScatterPoint): Marker => {
    if (viewMode === "model") {
      const index = modelOrder.indexOf(point.model);
      const colorVar = modelColorVars[index];
      return {
        color: colorVar ? `var(${colorVar})` : otherModelColor,
        label: index >= 0 ? point.model || "(미상)" : "기타 모델",
        shape: "circle",
      };
    }
    return categoryMarkers[pointCategory(point)];
  };

  // One path per look, painted in ascending urgency so problems stay visible over normal traffic.
  const layers = useMemo(() => {
    const groups = new Map<string, { marker: Marker; rank: number; d: string[] }>();
    for (const { point, x, y } of layout.plotted) {
      const marker = markerFor(point);
      const rank = viewMode === "category" ? scatterCategories.indexOf(pointCategory(point)) : 0;
      const key = `${marker.color}|${marker.shape}`;
      let group = groups.get(key);
      if (!group) {
        group = { marker, rank, d: [] };
        groups.set(key, group);
      }
      group.d.push(markerPath(marker.shape, x, y, markerSize));
    }
    return [...groups.entries()]
      .sort((left, right) => left[1].rank - right[1].rank)
      .map(([key, group]) => ({ key, color: group.marker.color, d: group.d.join("") }));
    // markerFor only reads viewMode and modelOrder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.plotted, modelOrder, viewMode]);

  const fresh = useMemo(() => {
    if (!timeDomain) return [];
    return layout.plotted
      .filter(({ point }) => timeDomain.to - Date.parse(point.created_at) < freshWindowMs)
      .slice(-freshMarkers);
  }, [layout.plotted, timeDomain]);

  const toLocal = (event: React.PointerEvent<SVGSVGElement>): { x: number; y: number } => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return { x: 0, y: 0 };
    return {
      x: ((event.clientX - rect.left) / rect.width) * width,
      y: ((event.clientY - rect.top) / rect.height) * height,
    };
  };

  const finishDrag = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (!drag) return;
    const left = Math.min(drag.x1, drag.x2);
    const right = Math.max(drag.x1, drag.x2);
    const top = Math.min(drag.y1, drag.y2);
    const bottom = Math.max(drag.y1, drag.y2);
    setDrag(undefined);
    if (right - left < 4 && bottom - top < 4) {
      const local = toLocal(event);
      const hit = nearestPlottedPoint(layout.plotted, local.x, local.y, hoverRadius);
      if (hit) onSelect([hit.point]);
      return;
    }
    onSelect(
      layout.plotted
        .filter(({ x, y }) => x >= left && x <= right && y >= top && y <= bottom)
        .map(({ point }) => point),
    );
  };

  const hovered = hover && layout.plotted.find(({ point }) => point === hover.point);
  const axisTimes = timeTicks(layout.from, layout.to);
  const metricLabel = scatterMetrics.find((item) => item.value === metric)?.label;

  return (
    <div className="obs-viz">
      <div
        className="obs-scatter-shell"
        data-selecting={drag !== undefined}
        data-hovering={hovered !== undefined}
      >
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
            const local = toLocal(event);
            if (drag) {
              setDrag((current) => (current ? { ...current, x2: local.x, y2: local.y } : current));
              return;
            }
            setHover(nearestPlottedPoint(layout.plotted, local.x, local.y, hoverRadius));
          }}
          onPointerLeave={() => setHover(undefined)}
          onPointerUp={finishDrag}
          onPointerCancel={() => setDrag(undefined)}
        >
          <title id={titleId}>시간축 대비 {metricLabel} 분포 산점도</title>
          {layout.axis.ticks.map((tick) => {
            const y = layout.toY(tick);
            return (
              <g key={tick}>
                <line
                  className="obs-scatter-grid"
                  x1={padding.left}
                  x2={width - padding.right}
                  y1={y}
                  y2={y}
                />
                <text className="obs-scatter-axis" x={padding.left - 6} y={y + 3} textAnchor="end">
                  {formatMetric(metric, tick)}
                </text>
              </g>
            );
          })}
          {axisTimes.map((tick) => (
            <text
              key={tick}
              className="obs-scatter-axis"
              x={layout.toX(tick)}
              y={height - 10}
              textAnchor="middle"
            >
              {formatTimeTick(tick, layout.span, timeZone)}
            </text>
          ))}
          {shown.length > 1 ? (
            <g>
              <line
                className="obs-scatter-band"
                x1={padding.left}
                x2={width - padding.right}
                y1={layout.toY(layout.p95)}
                y2={layout.toY(layout.p95)}
              />
              <text
                className="obs-scatter-axis obs-scatter-band-label"
                x={width - padding.right - 4}
                y={layout.toY(layout.p95) - 4}
                textAnchor="end"
              >
                P95 {formatMetric(metric, layout.p95)}
              </text>
            </g>
          ) : null}
          {layers.map((layer) => (
            <path
              key={layer.key}
              d={layer.d}
              fill={layer.color}
              stroke="var(--color-card)"
              strokeWidth={1.5}
            />
          ))}
          {fresh.map(({ point, x, y }) => (
            <circle
              key={point.request_id}
              className="obs-scatter-fresh"
              cx={x}
              cy={y}
              r={9}
              stroke={markerFor(point).color}
            />
          ))}
          {hovered ? (
            <circle
              className="obs-scatter-hover"
              cx={hovered.x}
              cy={hovered.y}
              r={8}
              stroke={markerFor(hovered.point).color}
            />
          ) : null}
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
        {hovered && !drag ? (
          <div
            className="obs-scatter-tooltip"
            style={{
              left: `${(hovered.x / width) * 100}%`,
              top: `${(hovered.y / height) * 100}%`,
            }}
            data-flip={hovered.x > width * 0.65 ? "left" : "right"}
            aria-hidden="true"
          >
            <strong>{hovered.point.model || "(미상)"}</strong>
            <span>
              HTTP {formatNumber(hovered.point.status_code)} · {markerFor(hovered.point).label}
            </span>
            <span>{formatMetric(metric, metricValue(hovered.point, metric))}</span>
            <span>
              토큰 {formatNumber(hovered.point.total_tokens)} · {formatKRW(hovered.point.cost_krw)}
            </span>
            <span>{formatDateTime(hovered.point.created_at)}</span>
            <span className="obs-scatter-tooltip-hint">클릭하면 입력과 출력을 봅니다</span>
          </div>
        ) : null}
      </div>
      {viewMode === "category" ? (
        <ul className="obs-legend" aria-label="상태별 범례. 누르면 표시를 전환합니다">
          {[...scatterCategories].reverse().map((category) => {
            const marker = categoryMarkers[category];
            const hidden = hiddenCategories.has(category);
            return (
              <li key={category}>
                <button
                  type="button"
                  className="obs-legend-item obs-legend-toggle"
                  aria-pressed={!hidden}
                  onClick={() => onToggleCategory(category)}
                >
                  <span
                    className="obs-legend-swatch"
                    style={{ background: hidden ? "transparent" : marker.color }}
                  />
                  {marker.label} {formatNumber(categoryCounts[category])}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className="obs-legend">
          {modelOrder.map((model, index) => (
            <li key={model} className="obs-legend-item">
              <span
                className="obs-legend-swatch"
                style={{ background: `var(${modelColorVars[index] ?? "--obs-series-other"})` }}
              />
              {model || "(미상)"}
            </li>
          ))}
          <li className="obs-legend-item">
            <span className="obs-legend-swatch" style={{ background: otherModelColor }} />
            기타 모델
          </li>
        </ul>
      )}
      <details>
        <summary>표로 보기 (최근 {formatNumber(Math.min(shown.length, tableRowCap))}건)</summary>
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
                <th scope="col">작업</th>
              </tr>
            </thead>
            <tbody>
              {shown
                .slice(-tableRowCap)
                .reverse()
                .map((item, index) => (
                  <tr key={`${item.request_id}-${index}`}>
                    <th scope="row">{formatDateTime(item.created_at)}</th>
                    <td className="mono truncate">{item.request_id}</td>
                    <td>{item.model || "(미상)"}</td>
                    <td>{markerFor(item).label}</td>
                    <td className="cell-number">{formatMetric(metric, metricValue(item, metric))}</td>
                    <td>
                      <Button
                        size="small"
                        onClick={() => onSelect([item])}
                        aria-label={`${item.request_id} 선택`}
                      >
                        선택
                      </Button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
