import { useMemo } from "react";

import { bubbleLayout, type BubbleFrame } from "./bubble-layout";
import { ChartEmpty, ChartTable, PaintDefs } from "./chart-parts";
import { paintFill, type CategoryPaint } from "./palette";
import { useChartId } from "./use-chart-id";
import "./charts.css";

export interface BubbleDatum {
  id: string;
  label: string;
  x: number;
  y: number;
  /** The radius measure; `null` when withheld. */
  size: number | null;
  paint: CategoryPaint;
  selectable?: boolean;
}

interface BubbleChartProps {
  caption: string;
  data: readonly BubbleDatum[];
  xLabel: string;
  yLabel: string;
  sizeLabel: string;
  formatX: (value: number) => string;
  formatY: (value: number) => string;
  formatSize: (value: number | null) => string;
  onSelect?: (id: string) => void;
  selectHint?: string;
  /** Said instead of the default when there is nothing to draw, e.g. because every item is withheld. */
  emptyMessage?: string;
}

const frame: BubbleFrame = {
  width: 720,
  height: 340,
  padding: { top: 30, right: 36, bottom: 44, left: 72 },
  radius: { min: 6, max: 26 },
};
const directLabels = 8;
const minimumHit = 24;

const shorten = (text: string, limit = 14): string =>
  [...text].length > limit ? `${[...text].slice(0, limit - 1).join("")}…` : text;

/** x = usage, y = cost, area = active users. Two axes of different units, one mark per item. */
export function BubbleChart({
  caption,
  data,
  xLabel,
  yLabel,
  sizeLabel,
  formatX,
  formatY,
  formatSize,
  onSelect,
  selectHint,
  emptyMessage = "표시할 값이 없습니다.",
}: BubbleChartProps): React.JSX.Element {
  const id = useChartId();
  const layout = useMemo(
    () =>
      bubbleLayout(
        data.map((item) => ({ id: item.id, x: item.x, y: item.y, size: item.size })),
        frame,
      ),
    [data],
  );
  if (data.length === 0) return <ChartEmpty>{emptyMessage}</ChartEmpty>;
  const byId = new Map(data.map((item) => [item.id, item]));
  const labelled = new Set(layout.marks.slice(0, directLabels).map((mark) => mark.id));
  const right = frame.width - frame.padding.right;
  const bottom = frame.height - frame.padding.bottom;
  const describe = (item: BubbleDatum): string =>
    `${item.label} · ${xLabel} ${formatX(item.x)} · ${yLabel} ${formatY(item.y)} · ${sizeLabel} ${formatSize(item.size)}`;

  return (
    <figure className="wi-viz wi-chart">
      <div className="wi-chart-scroll" tabIndex={0} role="region" aria-label={`${caption} 그래프 영역`}>
        <div className="wi-chart-canvas wi-chart-wide">
          <svg viewBox={`0 0 ${frame.width} ${frame.height}`} role="img" aria-labelledby={`${id}-title`}>
            <title id={`${id}-title`}>{caption}</title>
            <PaintDefs id={id} paints={data.map((item) => item.paint)} />
            {layout.yTicks.map((value) => (
              <g key={`y${value}`}>
                <line
                  className="wi-grid-line"
                  x1={frame.padding.left}
                  x2={right}
                  y1={layout.y(value)}
                  y2={layout.y(value)}
                />
                <text
                  className="wi-axis-text"
                  x={frame.padding.left - 8}
                  y={layout.y(value) + 4}
                  textAnchor="end"
                >
                  {formatY(value)}
                </text>
              </g>
            ))}
            {layout.xTicks.map((value) => (
              <text
                key={`x${value}`}
                className="wi-axis-text"
                x={layout.x(value)}
                y={bottom + 16}
                textAnchor="middle"
              >
                {formatX(value)}
              </text>
            ))}
            <text className="wi-axis-text" x={frame.padding.left} y={14}>
              {yLabel}
            </text>
            <text className="wi-axis-text" x={right} y={frame.height - 6} textAnchor="end">
              {xLabel}
            </text>
            {layout.marks.map((mark) => {
              const item = byId.get(mark.id);
              if (!item) return null;
              const selectable = Boolean(onSelect) && item.selectable !== false;
              const labelLeft = mark.cx > frame.width * 0.72;
              return (
                <g key={mark.id}>
                  <circle
                    className="wi-mark"
                    data-selectable={selectable ? "true" : undefined}
                    cx={mark.cx}
                    cy={mark.cy}
                    r={mark.r}
                    style={{
                      fill: paintFill(item.paint, id),
                      fillOpacity: mark.sized ? 0.78 : 0.3,
                      stroke: mark.sized ? "var(--color-card)" : `var(${item.paint.colorVar})`,
                      strokeWidth: 2,
                      strokeDasharray: mark.sized ? undefined : "3 3",
                    }}
                    onClick={selectable ? () => onSelect?.(mark.id) : undefined}
                  >
                    <title>{describe(item)}</title>
                  </circle>
                  {labelled.has(mark.id) ? (
                    <text
                      className="wi-label-text"
                      x={labelLeft ? mark.cx - mark.r - 5 : mark.cx + mark.r + 5}
                      y={mark.cy + 4}
                      textAnchor={labelLeft ? "end" : "start"}
                      style={{ paintOrder: "stroke", stroke: "var(--color-card)", strokeWidth: 3 }}
                    >
                      {shorten(item.label)}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
          {onSelect
            ? layout.marks.map((mark) => {
                const item = byId.get(mark.id);
                if (!item || item.selectable === false) return null;
                const diameter = Math.max(minimumHit, mark.r * 2);
                return (
                  <button
                    key={mark.id}
                    type="button"
                    className="wi-hit"
                    data-shape="circle"
                    style={{
                      left: `${((mark.cx - diameter / 2) / frame.width) * 100}%`,
                      top: `${((mark.cy - diameter / 2) / frame.height) * 100}%`,
                      width: `${(diameter / frame.width) * 100}%`,
                      height: `${(diameter / frame.height) * 100}%`,
                    }}
                    aria-label={`${describe(item)}${selectHint ? ` · ${selectHint}` : ""}`}
                    title={describe(item)}
                    onClick={() => onSelect(mark.id)}
                  />
                );
              })
            : null}
        </div>
      </div>
      <p className="wi-chart-note">
        원의 넓이는 {sizeLabel}입니다. 점선 원은 {sizeLabel}가 가려진 항목으로, 가장 작은 크기로 그립니다.
      </p>
      <ChartTable
        caption={caption}
        head={["항목", xLabel, yLabel, sizeLabel]}
        rows={data.map((item) => [item.label, formatX(item.x), formatY(item.y), formatSize(item.size)])}
      />
    </figure>
  );
}
