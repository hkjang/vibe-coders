import { useTable, type RowData } from "@tanstack/react-table";
import type { MouseEvent } from "react";

import { Button } from "@/shared/components/ui/Button";
import { dataTableFeatures, type DataTableColumn } from "@/shared/data-table/columns";

interface DataTableBaseProps<TData extends RowData> {
  caption: string;
  columns: ReadonlyArray<DataTableColumn<TData>>;
  data: ReadonlyArray<TData>;
  emptyMessage?: string;
  error?: string;
  getRowId?: (row: TData, index: number) => string;
  loading?: boolean;
  onPageChange?: (pageIndex: number) => void;
  onRetry?: () => void;
  pageCount?: number;
  pageIndex?: number;
}

type DataTableRowAction<TData extends RowData> =
  | { getRowActionLabel?: never; onRowClick?: never }
  | { getRowActionLabel: (row: TData) => string; onRowClick: (row: TData) => void };

type DataTableProps<TData extends RowData> = DataTableBaseProps<TData> & DataTableRowAction<TData>;

export function DataTable<TData extends RowData>({
  caption,
  columns,
  data,
  emptyMessage = "표시할 데이터가 없습니다.",
  error,
  getRowActionLabel,
  getRowId,
  loading = false,
  onPageChange,
  onRetry,
  onRowClick,
  pageCount = 1,
  pageIndex = 0,
}: DataTableProps<TData>): React.JSX.Element {
  const table = useTable({
    columns,
    data,
    features: dataTableFeatures,
    getRowId,
  });
  const columnCount = Math.max(1, table.getAllLeafColumns().length + (onRowClick ? 1 : 0));
  const rows = table.getRowModel().rows;
  const currentPage = Math.min(Math.max(pageIndex, 0), Math.max(pageCount - 1, 0));

  const targetIsInteractive = (target: EventTarget | null, row: HTMLTableRowElement): boolean => {
    if (!(target instanceof Element)) return false;
    const interactive = target.closest(
      'a, button, input, select, textarea, label, summary, [contenteditable="true"], [role="button"], [role="link"], [tabindex]',
    );
    return interactive !== null && row.contains(interactive);
  };

  const activateRow = (event: MouseEvent<HTMLTableRowElement>, original: TData): void => {
    if (!onRowClick || event.defaultPrevented || targetIsInteractive(event.target, event.currentTarget))
      return;
    onRowClick(original);
  };

  return (
    <section className="data-table-shell" aria-busy={loading || undefined}>
      <div className="data-table-scroll" tabIndex={0} aria-label={`${caption} 표 영역`}>
        <table className="data-table">
          <caption className="sr-only">{caption}</caption>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th key={header.id} colSpan={header.colSpan} scope="col">
                    {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                  </th>
                ))}
                {onRowClick ? (
                  <th scope="col">
                    <span className="sr-only">행 작업</span>
                  </th>
                ) : null}
              </tr>
            ))}
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={columnCount} className="data-table-state">
                  <div role="status">데이터를 불러오는 중입니다.</div>
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td colSpan={columnCount} className="data-table-state data-table-error">
                  <div role="alert">
                    <span>{error}</span>
                    {onRetry ? (
                      <Button size="small" onClick={onRetry}>
                        다시 시도
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columnCount} className="data-table-state">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  className={onRowClick ? "data-table-row-action" : undefined}
                  onClick={onRowClick ? (event) => activateRow(event, row.original) : undefined}
                >
                  {row.getAllCells().map((cell) => (
                    <td key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </td>
                  ))}
                  {onRowClick && getRowActionLabel ? (
                    <td className="data-table-action-cell">
                      <Button
                        size="small"
                        variant="ghost"
                        aria-label={getRowActionLabel(row.original)}
                        onClick={() => onRowClick(row.original)}
                      >
                        상세
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && onPageChange ? (
        <nav className="data-table-pagination" aria-label={`${caption} 페이지`}>
          <Button
            size="small"
            disabled={currentPage === 0 || loading}
            onClick={() => onPageChange(currentPage - 1)}
          >
            이전
          </Button>
          <span aria-live="polite">
            {currentPage + 1} / {pageCount}
          </span>
          <Button
            size="small"
            disabled={currentPage >= pageCount - 1 || loading}
            onClick={() => onPageChange(currentPage + 1)}
          >
            다음
          </Button>
        </nav>
      ) : null}
    </section>
  );
}
