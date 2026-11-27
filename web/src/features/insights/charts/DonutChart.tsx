import { useMemo } from "react";

import { formatPercent } from "@/shared/utils/format";

import { ChartEmpty, ChartLegend, ChartTable, PaintDefs } from "./chart-parts";
import { donutArcs } from "./donut-layout";
import { paintFill, type CategoryPaint } from "./palette";
import { useChartId } from "./use-chart-id";
import "./charts.css";

export interface DonutDatum {
  id: string;
  label: string;
  /** The slice size; 0 (or a withheld value) draws no slice but stays in the legend. */
  value: number;
  /** The value as text, e.g. "1,234" or "보호됨". */
  display: string;
  paint: CategoryPaint;
  selectable?: boolean;
  /** The value is withheld: it has no slice, and its share is not stated (it would read as 0%). */
  withheld?: boolean;
}

interface DonutChartProps {
  caption: string;
  data: readonly DonutDatum[];
  centerValue: string;
  centerLabel: string;
  valueHeader: string;
  onSelect?: (id: string) => void;
  selectHint?: string;
  /** What a withheld share reads as in the table view. */
  withheldLabel?: string;
}

const geometry = { cx: 100, cy: 100, outer: 94, inner: 60, gap: 2 };

/** Share of a whole. The legend beside it carries every value and is the keyboard route. */
export function DonutChart({
  caption,
  data,
  centerValue,
  centerLabel,
  valueHeader,
  onSelect,
  selectHint,
  withheldLabel = "보호됨",
}: DonutChartProps): React.JSX.Element {
  const id = useChartId();
  const arcs = useMemo(
    () =>
      donutArcs(
        data.map((item) => ({ id: item.id, value: item.value })),
        geometry,
      ),
    [data],
  );
  const shares = new Map(arcs.map((arc) => [arc.id, arc.share]));
  const byId = new Map(data.map((item) => [item.id, item]));
  const share = (item: DonutDatum): string => formatPercent(shares.get(item.id) ?? 0);

  // Nothing to draw but withheld items: keep the ring, the centre total and the legend, so
  // the withheld items still read as 보호됨 rather than vanishing behind "no values".
  const blank = arcs.length === 0;
  if (blank && !data.some((item) => item.withheld)) return <ChartEmpty>표시할 값이 없습니다.</ChartEmpty>;

  return (
    <figure className="wi-viz wi-chart">
      <div className="wi-donut">
        <svg viewBox="0 0 200 200" role="img" aria-labelledby={`${id}-title`}>
          <title id={`${id}-title`}>{caption}</title>
          <PaintDefs id={id} paints={data.map((item) => item.paint)} />
          {blank ? (
            <circle
              data-withheld="true"
              cx={geometry.cx}
              cy={geometry.cy}
              r={(geometry.outer + geometry.inner) / 2}
              style={{ fill: "none", stroke: "var(--wi-grid)", strokeWidth: geometry.outer - geometry.inner }}
            >
              <title>{`${caption} · ${withheldLabel}`}</title>
            </circle>
          ) : null}
          {arcs.map((arc) => {
            const item = byId.get(arc.id);
            if (!item) return null;
            const selectable = Boolean(onSelect) && item.selectable !== false;
            return (
              <path
                key={arc.id}
                className="wi-mark"
                data-selectable={selectable ? "true" : undefined}
                d={arc.path}
                style={{ fill: paintFill(item.paint, id) }}
                onClick={selectable ? () => onSelect?.(arc.id) : undefined}
              >
                <title>{`${item.label} · ${item.display} · ${formatPercent(arc.share)}`}</title>
              </path>
            );
          })}
          <text className="wi-donut-center-value" x={100} y={102} textAnchor="middle">
            {centerValue}
          </text>
          <text className="wi-donut-center-label" x={100} y={120} textAnchor="middle">
            {centerLabel}
          </text>
        </svg>
        <ChartLegend
          label={`${caption} 범례`}
          layout="column"
          onSelect={onSelect}
          selectHint={selectHint}
          entries={data.map((item) => ({
            id: item.id,
            label: item.label,
            paint: item.paint,
            value: item.display,
            detail: item.withheld ? undefined : share(item),
            selectable: item.selectable,
          }))}
        />
      </div>
      <ChartTable
        caption={caption}
        head={["항목", valueHeader, "비중"]}
        rows={data.map((item) => [item.label, item.display, item.withheld ? withheldLabel : share(item)])}
      />
    </figure>
  );
}
