import { useMemo, type ReactNode } from "react";

import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";

export interface SimpleColumn<Row extends object> {
  id: string;
  header: string;
  cell: (row: Row) => ReactNode;
}

interface SimpleTableProps<Row extends object> {
  caption: string;
  columns: ReadonlyArray<SimpleColumn<Row>>;
  emptyMessage?: string;
  error?: string;
  loading?: boolean;
  onRetry?: () => void;
  rows: ReadonlyArray<Row>;
}

/**
 * Thin wrapper over `DataTable` for the many read-only analytic tables on the data
 * screens: a column is just a header and a cell renderer.
 */
export function SimpleTable<Row extends object>({
  caption,
  columns,
  emptyMessage,
  error,
  loading,
  onRetry,
  rows,
}: SimpleTableProps<Row>): React.JSX.Element {
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
