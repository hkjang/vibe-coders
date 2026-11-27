import { BarFill, ChartEmpty, Swatch } from "./chart-parts";
import { barPercent, heatPeak } from "./heatmap-model";
import type { CategoryPaint } from "./palette";
import "./charts.css";

export interface RankedBarDatum {
  id: string;
  label: string;
  /** `null` when the value is withheld. */
  value: number | null;
  display: string;
  /** Secondary text under the value, such as the change from the previous period. */
  detail?: string;
  paint: CategoryPaint;
  selectable?: boolean;
}

interface RankedBarsProps {
  label: string;
  items: readonly RankedBarDatum[];
  onSelect?: (id: string) => void;
  selectHint?: string;
}

/** Horizontal bars in the order given. A selectable row is one button, value included. */
export function RankedBars({ label, items, onSelect, selectHint }: RankedBarsProps): React.JSX.Element {
  if (items.length === 0) return <ChartEmpty>표시할 값이 없습니다.</ChartEmpty>;
  const peak = heatPeak(items.map((item) => item.value));
  return (
    <ol className="wi-viz wi-bars" aria-label={label}>
      {items.map((item) => {
        const body = (
          <>
            <span className="wi-bar-label">
              <Swatch paint={item.paint} />
              <span title={item.label}>{item.label}</span>
            </span>
            <BarFill paint={item.paint} percent={barPercent(item.value, peak)} />
            <span className="wi-bar-value">
              <span>{item.display}</span>
              {item.detail ? <small>{item.detail}</small> : null}
            </span>
          </>
        );
        return (
          <li key={item.id}>
            {onSelect && item.selectable !== false ? (
              <button type="button" className="wi-bar-row" onClick={() => onSelect(item.id)}>
                {body}
                {selectHint ? <span className="sr-only">{selectHint}</span> : null}
              </button>
            ) : (
              <div className="wi-bar-row">{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
