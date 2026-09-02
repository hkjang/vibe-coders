import { createColumnHelper, tableFeatures, type ColumnDef, type RowData } from "@tanstack/react-table";

export const dataTableFeatures = tableFeatures({});

export type DataTableColumn<TData extends RowData> = ColumnDef<typeof dataTableFeatures, TData, unknown>;

export function createDataTableColumnHelper<TData extends RowData>() {
  return createColumnHelper<typeof dataTableFeatures, TData>();
}
