import type { ReactNode } from "react";
import type { DataTableSort } from "@/shared/data-table/DataTable";
export interface IpColumn<Row extends object> {
  id: string;
  header: string;
  value: (row: Row) => string | number | undefined;
  cell?: (row: Row) => ReactNode;
}
export function orderIpRows<Row extends object>(
  rows: readonly Row[],
  columns: readonly IpColumn<Row>[],
  query: string,
  sorts: readonly DataTableSort[],
) {
  const needle = query.toLocaleLowerCase("ko");
  const result = query
    ? rows.filter((row) =>
        columns.some((column) =>
          String(column.value(row) ?? "")
            .toLocaleLowerCase("ko")
            .includes(needle),
        ),
      )
    : rows;
  if (!sorts.length) return result;
  return [...result].sort((a, b) => {
    for (const sort of sorts) {
      const column = columns.find((column) => column.id === sort.columnId);
      if (!column) continue;
      const left = column.value(a),
        right = column.value(b);
      if (left === undefined) {
        if (right !== undefined) return 1;
        else continue;
      }
      if (right === undefined) return -1;
      const difference =
        typeof left === "number" && typeof right === "number"
          ? left - right
          : String(left).localeCompare(String(right), "ko", { numeric: true });
      if (difference) return sort.direction === "desc" ? -difference : difference;
    }
    return 0;
  });
}
