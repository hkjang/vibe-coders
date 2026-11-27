import type { CSSProperties, ReactNode } from "react";

import type { CategoryPaint } from "./palette";

const swatchStyle = (paint: CategoryPaint): CSSProperties =>
  ({ "--wi-swatch": `var(${paint.colorVar})` }) as CSSProperties;

/** Hatch patterns for the hatched paints a chart uses; referenced by `paintFill`. */
export function PaintDefs({
  id,
  paints,
}: {
  id: string;
  paints: readonly CategoryPaint[];
}): React.JSX.Element | null {
  const hatched = [
    ...new Map(paints.filter((paint) => paint.hatched).map((paint) => [paint.key, paint])).values(),
  ];
  if (hatched.length === 0) return null;
  return (
    <defs>
      {hatched.map((paint) => (
        <pattern
          key={paint.key}
          id={`${id}-${paint.key}`}
          width={6}
          height={6}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width={6} height={6} style={{ fill: `var(${paint.colorVar})` }} />
          <rect width={2.5} height={6} style={{ fill: "var(--color-card)" }} />
        </pattern>
      ))}
    </defs>
  );
}

export function Swatch({ paint }: { paint: CategoryPaint }): React.JSX.Element {
  return (
    <span
      className="wi-swatch"
      data-hatched={paint.hatched ? "true" : undefined}
      style={swatchStyle(paint)}
      aria-hidden="true"
    />
  );
}

/** The fill of an HTML bar in a paint's colour. */
export function BarFill({ paint, percent }: { paint: CategoryPaint; percent: number }): React.JSX.Element {
  return (
    <span className="wi-bar-track" aria-hidden="true">
      <span
        className="wi-bar-fill"
        data-hatched={paint.hatched ? "true" : undefined}
        style={{ ...swatchStyle(paint), width: `${percent}%` }}
      />
    </span>
  );
}

export interface LegendEntry {
  id: string;
  label: string;
  paint: CategoryPaint;
  /** The entry's value as text; a legend without values would make colour the only key. */
  value?: string;
  detail?: string;
  selectable?: boolean;
}

interface ChartLegendProps {
  entries: readonly LegendEntry[];
  label: string;
  layout?: "row" | "column";
  onSelect?: (id: string) => void;
  /** Read after an entry's name, e.g. "하위 분류 보기". */
  selectHint?: string;
}

/**
 * The colour key with values. Selectable entries are buttons: an SVG picture has
 * no focusable parts, so this list is how a keyboard reaches "select this series".
 */
export function ChartLegend({
  entries,
  label,
  layout = "row",
  onSelect,
  selectHint,
}: ChartLegendProps): React.JSX.Element {
  return (
    <ul className="wi-legend" data-layout={layout} aria-label={label}>
      {entries.map((entry) => {
        const body = (
          <>
            <Swatch paint={entry.paint} />
            <span className="wi-legend-label" title={entry.label}>
              {entry.label}
            </span>
            {entry.value !== undefined ? <span className="wi-legend-value">{entry.value}</span> : null}
            {entry.detail !== undefined ? <span className="wi-legend-detail">{entry.detail}</span> : null}
          </>
        );
        return (
          <li key={entry.id}>
            {onSelect && entry.selectable !== false ? (
              <button type="button" className="wi-legend-entry" onClick={() => onSelect(entry.id)}>
                {body}
                {selectHint ? <span className="sr-only">{selectHint}</span> : null}
              </button>
            ) : (
              <span className="wi-legend-entry">{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

interface ChartTableProps {
  caption: string;
  head: readonly string[];
  /** The first cell of a row is its header. */
  rows: readonly (readonly ReactNode[])[];
  summary?: string;
}

/** "표로 보기": the same values as text, for assistive technology and for copying. */
export function ChartTable({
  caption,
  head,
  rows,
  summary = "표로 보기",
}: ChartTableProps): React.JSX.Element {
  return (
    <details className="wi-chart-table">
      <summary>{summary}</summary>
      <div className="data-table-scroll" tabIndex={0} role="region" aria-label={`${caption} 표 영역`}>
        <table className="data-table data-table-auto">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {head.map((cell, index) => (
                <th key={`${cell}-${index}`} scope="col">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, index) =>
                  index === 0 ? (
                    <th key={index} scope="row">
                      {cell}
                    </th>
                  ) : (
                    <td key={index} className="cell-number">
                      {cell}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function ChartEmpty({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <p className="wi-chart-note" role="status">
      {children}
    </p>
  );
}
