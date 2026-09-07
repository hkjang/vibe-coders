import { useMemo, type ReactNode } from "react";

import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

export interface PromptColumn<Row extends object> {
  id: string;
  header: string;
  cell: (row: Row) => ReactNode;
}

interface PromptTableProps<Row extends object> {
  caption: string;
  columns: ReadonlyArray<PromptColumn<Row>>;
  emptyMessage?: string;
  error?: string;
  loading?: boolean;
  onRetry?: () => void;
  rows: ReadonlyArray<Row>;
}

/** Read-only table wrapper: a column is a header plus a cell renderer. */
export function PromptTable<Row extends object>({
  caption,
  columns,
  emptyMessage,
  error,
  loading,
  onRetry,
  rows,
}: PromptTableProps<Row>): React.JSX.Element {
  const tableColumns = useMemo<ReadonlyArray<DataTableColumn<Row>>>(() => {
    const helper = createDataTableColumnHelper<Row>();
    return columns.map((column) =>
      helper.display({
        id: column.id,
        header: column.header,
        cell: ({ row }) => column.cell(row.original),
      }),
    );
  }, [columns]);

  return (
    <DataTable
      caption={caption}
      columns={tableColumns}
      data={rows}
      emptyMessage={emptyMessage}
      error={error}
      loading={loading}
      onRetry={onRetry}
    />
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
      title={`${label}을(를) 불러오지 못했습니다.`}
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
