import { heatLevel, heatLevels, heatPeak } from "./heatmap-model";
import { ChartEmpty } from "./chart-parts";
import "./charts.css";

export interface HeatmapColumn {
  id: string;
  label: string;
}

export interface HeatmapCell {
  columnId: string;
  /** `null` when the value is withheld or unknown. */
  value: number | null;
  suppressed: boolean;
  /** The value as text. */
  display: string;
}

export interface HeatmapRow {
  id: string;
  label: string;
  /** The row's own total as text, shown in the last column. */
  total?: string;
  cells: readonly HeatmapCell[];
}

interface HeatmapProps {
  caption: string;
  rowHeader: string;
  totalHeader?: string;
  columns: readonly HeatmapColumn[];
  rows: readonly HeatmapRow[];
  /** Shown in a withheld cell, e.g. "소수 보호". */
  suppressedLabel: string;
  /** Why a cell is withheld; the cell's tooltip and the scale note. */
  suppressedHint: string;
  onSelectCell?: (rowId: string, columnId: string) => void;
  onSelectColumn?: (columnId: string) => void;
  selectHint?: string;
}

/**
 * A table whose cells are tinted by value. Every cell prints its number, so the
 * tint is never the only encoding and the table needs no separate "표로 보기".
 */
export function Heatmap({
  caption,
  rowHeader,
  totalHeader,
  columns,
  rows,
  suppressedLabel,
  suppressedHint,
  onSelectCell,
  onSelectColumn,
  selectHint,
}: HeatmapProps): React.JSX.Element {
  if (rows.length === 0 || columns.length === 0) return <ChartEmpty>표시할 값이 없습니다.</ChartEmpty>;
  const peak = heatPeak(rows.flatMap((row) => row.cells.map((cell) => cell.value)));
  const anySuppressed = rows.some((row) => row.cells.some((cell) => cell.suppressed));
  return (
    <div className="wi-viz wi-chart">
      <div className="wi-heatmap-scroll" tabIndex={0} role="region" aria-label={`${caption} 표 영역`}>
        <table className="wi-heatmap">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">{rowHeader}</th>
              {columns.map((column) => (
                <th key={column.id} scope="col" title={column.label}>
                  {onSelectColumn ? (
                    <button
                      type="button"
                      className="wi-heat-button"
                      onClick={() => onSelectColumn(column.id)}
                    >
                      {column.label}
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              ))}
              {totalHeader ? <th scope="col">{totalHeader}</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const cells = new Map(row.cells.map((cell) => [cell.columnId, cell]));
              return (
                <tr key={row.id}>
                  <th scope="row" title={row.label}>
                    {row.label}
                  </th>
                  {columns.map((column) => {
                    const cell = cells.get(column.id);
                    if (!cell) {
                      return (
                        <td key={column.id} className="wi-heat-cell" data-level="0">
                          <span className="wi-heat-value">—</span>
                        </td>
                      );
                    }
                    if (cell.suppressed || cell.value === null) {
                      return (
                        <td
                          key={column.id}
                          className="wi-heat-cell"
                          data-suppressed="true"
                          title={suppressedHint}
                        >
                          <span className="wi-heat-value">{suppressedLabel}</span>
                        </td>
                      );
                    }
                    const level = heatLevel(cell.value, peak);
                    const name = `${row.label} · ${column.label} · ${cell.display}`;
                    return (
                      <td key={column.id} className="wi-heat-cell" data-level={level} title={name}>
                        {onSelectCell && cell.value > 0 ? (
                          <button
                            type="button"
                            className="wi-heat-button"
                            aria-label={`${name}${selectHint ? ` · ${selectHint}` : ""}`}
                            onClick={() => onSelectCell(row.id, column.id)}
                          >
                            {cell.display}
                          </button>
                        ) : (
                          <span className="wi-heat-value">{cell.display}</span>
                        )}
                      </td>
                    );
                  })}
                  {totalHeader ? <td className="cell-number">{row.total ?? "—"}</td> : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="wi-heat-scale">
        <span>낮음</span>
        <span aria-hidden="true">
          {Array.from({ length: heatLevels }, (_, index) => (
            <span key={index} className="wi-heat-scale-step" data-level={index + 1} />
          ))}
        </span>
        <span>높음</span>
        <span>· 색은 표에서 가장 큰 값 대비 크기이며 숫자가 실제 값입니다.</span>
        {anySuppressed ? (
          <span>
            · {suppressedLabel}: {suppressedHint}
          </span>
        ) : null}
      </p>
    </div>
  );
}
