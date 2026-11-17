import { validContextSort } from "@/shared/utils/context-registry-query";
import type { DataTableSort } from "@/shared/data-table/DataTable";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { contextMessages as text } from "./context-registry-messages";

export const contextSortColumns = [
  { id: "key", field: "key", label: text.columns.key },
  { id: "name", field: "name", label: text.columns.name },
  { id: "enabled", field: "enabled", label: text.columns.enabled },
  { id: "tokens", field: "token_estimate", label: text.columns.tokens },
  { id: "count", field: "use_count", label: text.columns.count },
] as const;
export function validContextSearch(value: string, prefixes: readonly string[]) {
  return (
    [...value].length <= 200 && !/[\p{Cc}\p{Cs}]/u.test(value) && !containsPotentialSecret(value, prefixes)
  );
}
export function readContextSearch(params: URLSearchParams, prefixes: readonly string[]) {
  const q = params.get("contexts_q")?.trim() ?? "";
  const sort = params.get("contexts_sort") ?? "";
  const valid =
    params.getAll("contexts_q").length <= 1 &&
    params.getAll("contexts_sort").length <= 1 &&
    validContextSearch(q, prefixes) &&
    validContextSort(sort);
  const sorts: DataTableSort[] =
    valid && sort
      ? sort.split(",").map((part) => {
          const [field, direction] = part.split(":");
          return {
            columnId: contextSortColumns.find((column) => column.field === field)?.id ?? "key",
            direction: direction === "desc" ? "desc" : "asc",
          };
        })
      : [];
  return { valid, q, sort, sorts };
}
export function contextSortValue(sorts: readonly DataTableSort[]) {
  return sorts
    .map((sort) => {
      const column = contextSortColumns.find((column) => column.id === sort.columnId);
      if (!column) throw new Error("Unsupported context sort column");
      return `${column.field}:${sort.direction}`;
    })
    .join(",");
}
