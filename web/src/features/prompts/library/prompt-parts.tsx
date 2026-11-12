import { createContext, useContext, useMemo, type ReactNode } from "react";

import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { queryFailureTitle } from "@/shared/messages/query";
import { useSearchState, pageFromParam } from "@/shared/hooks/use-search-state";

export interface PromptColumn<Row extends object> {
  id: string;
  header: string;
  cell: (row: Row) => ReactNode;
  sortValue?: (row: Row) => string | number | undefined;
}

interface PromptTableProps<Row extends object> {
  caption: string;
  tableId: "assets" | "search" | "fingerprints" | "debt" | "versions" | "usage";
  columns: ReadonlyArray<PromptColumn<Row>>;
  emptyMessage?: string;
  error?: string;
  loading?: boolean;
  onRetry?: () => void;
  rows: ReadonlyArray<Row>;
}

const PromptCellContext = createContext<(columnId: string, row: unknown) => ReactNode>(() => null);
function PromptCell({ columnId, row }: { columnId: string; row: unknown }) {
  return useContext(PromptCellContext)(columnId, row);
}

function promptRowID(row: object, index: number): string {
  const fields = row as Record<string, unknown>;
  for (const key of ["id", "fingerprint", "team"] as const) {
    if (typeof fields[key] === "string") return fields[key];
  }
  return String(index);
}

/** Read-only table wrapper: a column is a header plus a cell renderer. */
export function PromptTable<Row extends object>({
  caption,
  tableId,
  columns,
  emptyMessage,
  error,
  loading,
  onRetry,
  rows,
}: PromptTableProps<Row>): React.JSX.Element {
  const [params, updateSearch] = useSearchState();
  const sizes = [10, 25, 50] as const;
  const requestedSize = Number(params.get(`${tableId}_size`));
  const pageSize = sizes.find((size) => size === requestedSize) ?? 25;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const pageIndex = Math.min(pageFromParam(params.get(`${tableId}_page`)) - 1, pageCount - 1);
  const sortColumn = columns.find(
    (column) => column.id === params.get(`${tableId}_sort`) && column.sortValue,
  );
  const direction = params.get(`${tableId}_direction`) === "desc" ? "desc" : "asc";
  const ordered = useMemo(() => {
    if (!sortColumn?.sortValue) return rows;
    const value = sortColumn.sortValue;
    return [...rows].sort((a, b) => {
      const left = value(a),
        right = value(b);
      if (left === undefined) return right === undefined ? 0 : 1;
      if (right === undefined) return -1;
      const comparison =
        typeof left === "number" && typeof right === "number"
          ? left - right
          : String(left).localeCompare(String(right), "ko");
      return direction === "desc" ? -comparison : comparison;
    });
  }, [rows, sortColumn, direction]);
  const pageRows = useMemo(
    () => ordered.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
    [ordered, pageIndex, pageSize],
  );
  // Keep cell component identities stable while callbacks, rows or permissions
  // change. Replacing a cell renderer would disconnect dialog return-focus refs.
  const descriptorKey = JSON.stringify(columns.map(({ id, header }) => ({ id, header })));
  const tableColumns = useMemo<ReadonlyArray<DataTableColumn<Row>>>(() => {
    const helper = createDataTableColumnHelper<Row>();
    const descriptors = JSON.parse(descriptorKey) as { id: string; header: string }[];
    return descriptors.map((column) =>
      helper.display({
        id: column.id,
        header: column.header,
        cell: ({ row }) => <PromptCell columnId={column.id} row={row.original} />,
      }),
    );
  }, [descriptorKey]);

  return (
    <PromptCellContext.Provider
      value={(id, row) => columns.find((column) => column.id === id)?.cell(row as Row)}
    >
      <DataTable
        caption={caption}
        tableId={`prompts.library.${tableId}`}
        lockedColumnIds={columns[0] ? [columns[0].id] : []}
        columns={tableColumns}
        data={pageRows}
        getRowId={promptRowID}
        pageCount={pageCount}
        pageIndex={pageIndex}
        onPageChange={(page) => updateSearch({ [`${tableId}_page`]: page + 1 })}
        pageSizeControl={{
          value: pageSize,
          options: sizes,
          onChange: (size) => updateSearch({ [`${tableId}_size`]: size, [`${tableId}_page`]: undefined }),
        }}
        sorting={{
          columns: columns.filter((column) => column.sortValue).map((column) => ({ id: column.id })),
          value: sortColumn ? { columnId: sortColumn.id, direction } : undefined,
          onChange: (sort) =>
            updateSearch({
              [`${tableId}_sort`]: sort.columnId,
              [`${tableId}_direction`]: sort.direction,
              [`${tableId}_page`]: undefined,
            }),
        }}
        emptyMessage={emptyMessage}
        error={error}
        loading={loading}
        onRetry={onRetry}
      />
    </PromptCellContext.Provider>
  );
}

/** Partial failure of one panel: keeps the last good data and offers a retry. */
export function PanelFailure({
  error,
  hasData,
  label,
  onRetry,
}: {
  error: unknown;
  hasData: boolean;
  label: string;
  onRetry: () => void;
}): React.JSX.Element {
  const requestId = isAppError(error) ? error.requestId : undefined;
  return (
    <InlineNotice
      tone="warning"
      title={queryFailureTitle(label)}
      actions={
        <Button size="small" onClick={onRetry}>
          다시 시도
        </Button>
      }
    >
      {safeAppErrorMessage(error, "잠시 후 다시 시도해 주세요.")}
      {hasData ? " 마지막으로 확인된 내용을 표시합니다." : ""}
      {requestId ? ` 요청 ID: ${requestId}` : ""}
    </InlineNotice>
  );
}
