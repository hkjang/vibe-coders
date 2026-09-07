import type { RowData } from "@tanstack/react-table";
import type { ReactNode } from "react";

import type { DataTableColumn } from "@/shared/data-table/columns";

/**
 * Display column for the shared DataTable. The table's column type fixes the cell
 * value to `unknown`, so screens render from `row.original` instead of an accessor.
 */
export function displayColumn<TData extends RowData>(
  id: string,
  header: string,
  render: (row: TData) => ReactNode,
): DataTableColumn<TData> {
  return { id, header, cell: (info) => render(info.row.original) };
}
