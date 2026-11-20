import {
  columnOrderingFeature,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createColumnHelper,
  metaHelper,
  tableFeatures,
  type ColumnDef,
  type RowData,
} from "@tanstack/react-table";

export interface DataTableColumnHelp {
  description: string;
  /** A static display unit. Mixed currencies must be explained, never converted here. */
  unit?: string;
}

export const dataTableFeatures = tableFeatures({
  columnMeta: metaHelper<{ help?: DataTableColumnHelp; [key: string]: unknown }>(),
  columnVisibilityFeature,
  columnOrderingFeature,
  columnSizingFeature,
  columnResizingFeature,
});

export type DataTableColumn<TData extends RowData> = ColumnDef<typeof dataTableFeatures, TData, unknown>;

export function createDataTableColumnHelper<TData extends RowData>() {
  return createColumnHelper<typeof dataTableFeatures, TData>();
}
