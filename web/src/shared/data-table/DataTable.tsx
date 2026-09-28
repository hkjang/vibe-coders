import type { RowData } from "@tanstack/react-table";
import { Columns3, GripVertical, MoveHorizontal } from "lucide-react";
import { useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";

import { Button } from "@/shared/components/ui/Button";
import { type DataTableColumn } from "@/shared/data-table/columns";
import { DataTableSettingsDialog } from "@/shared/data-table/DataTableSettingsDialog";
import {
  dataTableColumnLabel,
  useDataTableLayout,
  useDataTableOverflow,
} from "@/shared/data-table/use-data-table-layout";
import {
  maximumDataTableColumnWidth,
  minimumDataTableColumnWidth,
} from "@/shared/data-table/table-preferences";

interface DataTableBaseProps<TData extends RowData> {
  caption: string;
  columns: ReadonlyArray<DataTableColumn<TData>>;
  data: ReadonlyArray<TData>;
  emptyMessage?: string;
  error?: string;
  getRowId?: (row: TData, index: number) => string;
  /** Columns that must remain visible, such as the resource identity column. */
  lockedColumnIds?: readonly string[];
  loading?: boolean;
  onPageChange?: (pageIndex: number) => void;
  onRetry?: () => void;
  pageCount?: number;
  pageIndex?: number;
  /**
   * Enables layout controls and persists only column ids, order, visibility and
   * widths. Row data, filters and cursors are never written to storage.
   */
  tableId?: string;
}

type DataTableRowAction<TData extends RowData> =
  | { getRowActionLabel?: never; onRowClick?: never }
  | { getRowActionLabel: (row: TData) => string; onRowClick: (row: TData) => void };

type DataTableProps<TData extends RowData> = DataTableBaseProps<TData> & DataTableRowAction<TData>;

const skeletonRowCount = 5;

export function DataTable<TData extends RowData>({
  caption,
  columns,
  data,
  emptyMessage = "표시할 데이터가 없습니다.",
  error,
  getRowActionLabel,
  getRowId,
  lockedColumnIds = [],
  loading = false,
  onPageChange,
  onRetry,
  onRowClick,
  pageCount = 1,
  pageIndex = 0,
  tableId,
}: DataTableProps<TData>): React.JSX.Element {
  const layout = useDataTableLayout({ columns, data, getRowId, lockedColumnIds, tableId });
  const { scrollRef, scrollState, updateScrollState } = useDataTableOverflow(
    data,
    loading,
    layout.layoutVersion,
  );
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { table } = layout;
  const columnCount = Math.max(1, layout.visibleColumnCount + (onRowClick ? 1 : 0));
  const rows = table.getRowModel().rows;
  const currentPage = Math.min(Math.max(pageIndex, 0), Math.max(pageCount - 1, 0));

  const targetIsInteractive = (target: EventTarget | null, row: HTMLTableRowElement): boolean => {
    if (!(target instanceof Element)) return false;
    const interactive = target.closest(
      'a, button, input, select, textarea, label, summary, [contenteditable="true"], [role="button"], [role="link"], [tabindex]',
    );
    return interactive !== null && row.contains(interactive);
  };

  const activateRow = (event: ReactMouseEvent<HTMLTableRowElement>, original: TData): void => {
    if (!onRowClick || event.defaultPrevented || targetIsInteractive(event.target, event.currentTarget))
      return;
    onRowClick(original);
  };

  const configuredTableWidth = table.getTotalSize() + (onRowClick ? 72 : 0);
  const configuredTableStyle: CSSProperties | undefined = layout.configurable
    ? {
        minWidth: `${configuredTableWidth}px`,
        tableLayout: "fixed",
        width: `${configuredTableWidth}px`,
      }
    : undefined;

  return (
    <section className="data-table-shell" aria-busy={loading || undefined}>
      {layout.configurable ? (
        <div className="data-table-toolbar">
          <span aria-live="polite">
            전체 {layout.allLeafColumns.length.toLocaleString("ko-KR")}개 열 중{" "}
            {layout.visibleColumnCount.toLocaleString("ko-KR")}개 표시
          </span>
          <Button
            ref={settingsTriggerRef}
            size="small"
            variant="secondary"
            onClick={() => setSettingsOpen(true)}
          >
            <Columns3 aria-hidden="true" /> 열 설정
          </Button>
        </div>
      ) : null}
      {loading ? (
        <span className="sr-only" role="status">
          데이터를 불러오는 중입니다.
        </span>
      ) : null}
      <div
        className="data-table-scroll-frame"
        data-at-end={scrollState.atEnd || undefined}
        data-at-start={scrollState.atStart || undefined}
        data-overflow={scrollState.overflowing || undefined}
      >
        <div
          ref={scrollRef}
          className="data-table-scroll"
          tabIndex={layout.configurable ? (scrollState.overflowing ? 0 : undefined) : 0}
          aria-label={
            scrollState.overflowing
              ? `${caption} 표 영역. 좌우로 스크롤하면 추가 열을 볼 수 있습니다.`
              : `${caption} 표 영역`
          }
          onScroll={updateScrollState}
        >
          <table className="data-table" style={configuredTableStyle}>
            <caption className="sr-only">{caption}</caption>
            <thead>
              {table.getHeaderGroups().map((group) => (
                <tr key={group.id}>
                  {group.headers.map((header) => {
                    const resizable =
                      layout.configurable && header.subHeaders.length === 0 && header.column.getCanResize();
                    const size = header.getSize();
                    const label = dataTableColumnLabel(header.column);
                    return (
                      <th
                        key={header.id}
                        className={resizable ? "data-table-resizable-heading" : undefined}
                        colSpan={header.colSpan}
                        scope="col"
                        style={layout.configurable ? { width: size } : undefined}
                      >
                        <span className="data-table-header-content">
                          {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                        </span>
                        {resizable ? (
                          <div
                            className="data-table-resizer"
                            role="separator"
                            tabIndex={0}
                            aria-label={`${label} 열 너비 조절`}
                            aria-orientation="vertical"
                            aria-valuemax={maximumDataTableColumnWidth}
                            aria-valuemin={minimumDataTableColumnWidth}
                            aria-valuenow={Math.round(size)}
                            title="드래그하거나 왼쪽·오른쪽 화살표로 너비 조절"
                            onDoubleClick={() => header.column.resetSize()}
                            onKeyDown={(event) => {
                              if (layout.resizeColumnByKey(header.column.id, size, event.key)) {
                                event.preventDefault();
                              }
                            }}
                            onMouseDown={header.getResizeHandler()}
                            onTouchStart={header.getResizeHandler()}
                          >
                            <GripVertical aria-hidden="true" />
                          </div>
                        ) : null}
                      </th>
                    );
                  })}
                  {onRowClick ? (
                    <th scope="col" className="data-table-action-heading">
                      <span className="sr-only">행 작업</span>
                    </th>
                  ) : null}
                </tr>
              ))}
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: skeletonRowCount }, (_, rowIndex) => (
                  <tr className="data-table-skeleton-row" aria-hidden="true" key={`skeleton-${rowIndex}`}>
                    {layout.visibleLeafColumns.length === 0 ? (
                      <td colSpan={columnCount}>
                        <span className="skeleton data-table-skeleton-line" />
                      </td>
                    ) : (
                      layout.visibleLeafColumns.map((column) => (
                        <td
                          key={column.id}
                          style={layout.configurable ? { width: column.getSize() } : undefined}
                        >
                          <span className="skeleton data-table-skeleton-line" />
                        </td>
                      ))
                    )}
                    {onRowClick && layout.visibleLeafColumns.length > 0 ? (
                      <td className="data-table-action-cell">
                        <span className="skeleton data-table-skeleton-action" />
                      </td>
                    ) : null}
                  </tr>
                ))
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
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        style={layout.configurable ? { width: cell.column.getSize() } : undefined}
                      >
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
      </div>
      {scrollState.overflowing ? (
        <div className="data-table-overflow-hint" aria-hidden="true">
          <MoveHorizontal /> 좌우로 이동해 추가 열 보기
        </div>
      ) : null}
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

      {layout.configurable ? (
        <DataTableSettingsDialog
          announcement={layout.settingsAnnouncement}
          columns={layout.settingsColumns}
          onMove={layout.moveColumn}
          onOpenChange={setSettingsOpen}
          onReset={layout.resetSettings}
          onToggleVisibility={layout.toggleColumnVisibility}
          open={settingsOpen}
          returnFocusRef={settingsTriggerRef}
        />
      ) : null}
    </section>
  );
}
