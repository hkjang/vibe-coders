import {
  columnOrderingFeature,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createColumnHelper,
  tableFeatures,
  type ColumnDef,
  type RowData,
} from "@tanstack/react-table";

export const dataTableFeatures = tableFeatures({
  columnVisibilityFeature,
  columnOrderingFeature,
  columnSizingFeature,
  columnResizingFeature,
});

export type DataTableColumn<TData extends RowData> = ColumnDef<typeof dataTableFeatures, TData, unknown>;

export function createDataTableColumnHelper<TData extends RowData>() {
  return createColumnHelper<typeof dataTableFeatures, TData>();
}
