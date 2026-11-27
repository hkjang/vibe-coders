import { useMemo } from "react";

import { ChartEmpty, ChartTable, PaintDefs } from "./chart-parts";
import { paintFill, type CategoryPaint } from "./palette";
import { squarify } from "./treemap-layout";
import { useChartId } from "./use-chart-id";
import "./charts.css";

export interface TreemapDatum {
  id: string;
  label: string;
  value: number;
  display: string;
  /** Secondary text such as the share. */
  detail?: string;
  paint: CategoryPaint;
  selectable?: boolean;
}

interface TreemapProps {
  caption: string;
  data: readonly TreemapDatum[];
  valueHeader: string;
  detailHeader?: string;
  onSelect?: (id: string) => void;
  selectHint?: string;
  /** Said instead of the default when there is nothing to draw, e.g. because every value is withheld. */
  emptyMessage?: string;
}

const width = 720;
const height = 300;
const percent = (value: number, whole: number): string => `${(value / whole) * 100}%`;

/**
 * Squarified treemap. The picture is an SVG; each tile's text and its focusable
 * hit target are HTML laid over it in the same coordinates, so labels can
 * truncate and a keyboard can reach every tile.
 */
export function Treemap({
  caption,
  data,
  valueHeader,
  detailHeader = "비중",
  onSelect,
  selectHint,
  emptyMessage = "표시할 값이 없습니다.",
}: TreemapProps): React.JSX.Element {
  const id = useChartId();
  const tiles = useMemo(
    () =>
      squarify(
        data.map((item) => ({ id: item.id, value: item.value })),
        width,
        height,
      ),
    [data],
  );
  const byId = new Map(data.map((item) => [item.id, item]));
  if (tiles.length === 0) return <ChartEmpty>{emptyMessage}</ChartEmpty>;

  return (
    <figure className="wi-viz wi-chart">
      <div className="wi-chart-canvas wi-treemap-canvas">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-labelledby={`${id}-title`}
        >
          <title id={`${id}-title`}>{caption}</title>
          <PaintDefs id={id} paints={data.map((item) => item.paint)} />
          {tiles.map((tile) => {
            const item = byId.get(tile.id);
            if (!item) return null;
            // A 2-unit surface gap separates tiles; no outline is drawn around them.
            const x = tile.x + 1;
            const y = tile.y + 1;
            const w = Math.max(0, tile.width - 2);
            const h = Math.max(0, tile.height - 2);
            return (
              <g key={tile.id}>
                <rect
                  x={x}
                  y={y}
                  width={w}
                  height={h}
                  rx={3}
                  style={{ fill: paintFill(item.paint, id), fillOpacity: item.paint.hatched ? 0.45 : 0.22 }}
                />
                <rect
                  x={x}
                  y={y}
                  width={Math.min(5, w)}
                  height={h}
                  rx={1}
                  style={{ fill: `var(${item.paint.colorVar})` }}
                />
              </g>
            );
          })}
        </svg>
        {tiles.map((tile) => {
          const item = byId.get(tile.id);
          if (!item) return null;
          const style = {
            left: percent(tile.x, width),
            top: percent(tile.y, height),
            width: percent(tile.width, width),
            height: percent(tile.height, height),
          };
          const copy = (
            <span className="wi-treemap-copy">
              <strong>{item.label}</strong>
              <span>{item.detail ? `${item.display} · ${item.detail}` : item.display}</span>
            </span>
          );
          const title = `${item.label} · ${item.display}${item.detail ? ` · ${item.detail}` : ""}`;
          return onSelect && item.selectable !== false ? (
            <button
              key={tile.id}
              type="button"
              className="wi-hit wi-treemap-tile"
              style={style}
              title={title}
              aria-label={`${title}${selectHint ? ` · ${selectHint}` : ""}`}
              onClick={() => onSelect(tile.id)}
            >
              {copy}
            </button>
          ) : (
            <div key={tile.id} className="wi-hit wi-treemap-tile" style={style} title={title}>
              {copy}
            </div>
          );
        })}
      </div>
      <ChartTable
        caption={caption}
        head={["항목", valueHeader, detailHeader]}
        rows={data.map((item) => [item.label, item.display, item.detail ?? "—"])}
      />
    </figure>
  );
}
