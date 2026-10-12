import type { ProviderCatalogRow } from "./provider-catalog";
import type { ProviderCatalogSort, ProviderCatalogSortKey } from "@/shared/utils/provider-catalog-query";

const sortColumns = {
  name: { id: "provider", sortLabel: "공급자" },
  priority: { id: "failover", sortLabel: "우선순위" },
  timeout: { id: "timeout", sortLabel: "제한 시간" },
} as const;

export const providerTableSortColumns = Object.values(sortColumns);

function sortKey(sort: ProviderCatalogSort): ProviderCatalogSortKey {
  return sort.slice(0, sort.lastIndexOf("_")) as ProviderCatalogSortKey;
}

export function providerCatalogSortState(sort?: ProviderCatalogSort) {
  return sort
    ? {
        columnId: sortColumns[sortKey(sort)].id,
        direction: sort.endsWith("_asc") ? ("asc" as const) : ("desc" as const),
      }
    : undefined;
}

export function providerCatalogSortFromColumn(columnId: string, direction: "asc" | "desc") {
  const key = (Object.keys(sortColumns) as ProviderCatalogSortKey[]).find(
    (candidate) => sortColumns[candidate].id === columnId,
  );
  return key ? (`${key}_${direction}` as ProviderCatalogSort) : undefined;
}

export function providerCatalogSortLabel(sort?: ProviderCatalogSort): string {
  if (!sort) return "기본 순서 (우선순위·공급자 이름)";
  return `${sortColumns[sortKey(sort)].sortLabel} ${sort.endsWith("_asc") ? "오름차순" : "내림차순"}`;
}

/** Sort only public presentation/configuration values; never change routing priority. */
export function sortProviderCatalogRows(
  rows: readonly ProviderCatalogRow[],
  sort?: ProviderCatalogSort,
): readonly ProviderCatalogRow[] {
  if (!sort) return rows;
  const key = sortKey(sort);
  const direction = sort.endsWith("_asc") ? 1 : -1;
  return rows
    .map((row, index) => ({
      row,
      index,
      value:
        key === "name"
          ? row.displayName
          : key === "priority"
            ? row.provider.priority
            : row.provider.timeout_ms,
    }))
    .sort((left, right) => {
      const leftKnown = typeof left.value === "string" || Number.isFinite(left.value);
      const rightKnown = typeof right.value === "string" || Number.isFinite(right.value);
      if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
      const compared =
        typeof left.value === "string" && typeof right.value === "string"
          ? left.value.localeCompare(right.value)
          : typeof left.value === "number" && typeof right.value === "number" && leftKnown && rightKnown
            ? left.value - right.value
            : 0;
      return compared * direction || left.index - right.index;
    })
    .map(({ row }) => row);
}
