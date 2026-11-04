import type { ProviderCatalogRow } from "./provider-catalog";
import {
  providerCatalogSortList,
  type ProviderCatalogSort,
  type ProviderCatalogSortKey,
  type ProviderCatalogSortOrder,
} from "@/shared/utils/provider-catalog-query";

const sortColumns = {
  name: { id: "provider", label: "공급자", sortLabel: "공급자" },
  priority: { id: "failover", label: "우선순위", sortLabel: "우선순위" },
  timeout: { id: "timeout", label: "제한 시간", sortLabel: "제한 시간" },
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

export function providerCatalogSortLabel(sort?: ProviderCatalogSortOrder): string {
  const criteria = providerCatalogSortList(sort);
  if (criteria.length === 0) return "기본 순서 (우선순위·공급자 이름)";
  return criteria
    .map(
      (criterion) =>
        `${sortColumns[sortKey(criterion)].sortLabel} ${criterion.endsWith("_asc") ? "오름차순" : "내림차순"}`,
    )
    .join(" → ");
}

function sortValue(row: ProviderCatalogRow, key: ProviderCatalogSortKey): string | number {
  return key === "name"
    ? row.displayName
    : key === "priority"
      ? row.provider.priority
      : row.provider.timeout_ms;
}

/** Sort only public presentation/configuration values; never change routing priority. */
export function sortProviderCatalogRows(
  rows: readonly ProviderCatalogRow[],
  sort?: ProviderCatalogSortOrder,
): readonly ProviderCatalogRow[] {
  const criteria = providerCatalogSortList(sort).map((criterion) => ({
    key: sortKey(criterion),
    direction: criterion.endsWith("_asc") ? 1 : -1,
  }));
  if (criteria.length === 0) return rows;
  return rows
    .map((row, index) => ({
      row,
      index,
      values: criteria.map(({ key }) => sortValue(row, key)),
    }))
    .sort((left, right) => {
      for (const [index, { direction }] of criteria.entries()) {
        const leftValue = left.values[index];
        const rightValue = right.values[index];
        const leftKnown = typeof leftValue === "string" || Number.isFinite(leftValue);
        const rightKnown = typeof rightValue === "string" || Number.isFinite(rightValue);
        if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
        const compared =
          typeof leftValue === "string" && typeof rightValue === "string"
            ? leftValue.localeCompare(rightValue)
            : typeof leftValue === "number" && typeof rightValue === "number" && leftKnown && rightKnown
              ? leftValue - rightValue
              : 0;
        if (compared) return compared * direction;
      }
      return left.index - right.index;
    })
    .map(({ row }) => row);
}
