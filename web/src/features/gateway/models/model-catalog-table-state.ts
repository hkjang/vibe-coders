import type { ModelCatalogRow } from "./model-catalog";
import type { ModelCatalogSort, ModelCatalogSortKey } from "@/shared/utils/model-catalog-query";

const sortColumns = {
  model: { id: "model", label: "모델", initialDirection: "asc" },
  provider: { id: "provider", label: "공급자", initialDirection: "asc" },
  quality: { id: "quality", label: "품질", initialDirection: "desc" },
  success: { id: "success", label: "성공률", initialDirection: "desc" },
  input_price: { id: "input-price", label: "입력 가격", initialDirection: "asc" },
  output_price: { id: "output-price", label: "출력 가격", initialDirection: "asc" },
} as const;

export const modelTableSortColumns = Object.values(sortColumns);

export function modelCatalogSortState(sort?: ModelCatalogSort) {
  if (!sort) return undefined;
  const key = sort.slice(0, sort.lastIndexOf("_")) as ModelCatalogSortKey;
  return {
    columnId: sortColumns[key].id,
    direction: sort.endsWith("_asc") ? ("asc" as const) : ("desc" as const),
  };
}

export function modelCatalogSortFromColumn(columnId: string, direction: "asc" | "desc") {
  const key = (Object.keys(sortColumns) as ModelCatalogSortKey[]).find(
    (candidate) => sortColumns[candidate].id === columnId,
  );
  return key ? (`${key}_${direction}` as ModelCatalogSort) : undefined;
}

export function modelCatalogSortLabel(sort?: ModelCatalogSort): string {
  if (!sort) return "기본 순서 (공급자·모델·출처)";
  const key = sort.slice(0, sort.lastIndexOf("_")) as ModelCatalogSortKey;
  return `${sortColumns[key].label} ${sort.endsWith("_asc") ? "오름차순" : "내림차순"}`;
}

export function observedModelSuccessRate(row: ModelCatalogRow): number | undefined {
  return row.quality && row.quality.requests > 0 ? row.quality.success_rate : undefined;
}

function sortValue(row: ModelCatalogRow, key: ModelCatalogSortKey): number | string | undefined {
  switch (key) {
    case "model":
      return row.model.id;
    case "provider":
      return row.providerLabel;
    case "quality":
      return row.quality?.quality_score;
    case "success":
      return observedModelSuccessRate(row);
    case "input_price":
      return row.price?.input_krw_per_1m;
    case "output_price":
      return row.price?.output_krw_per_1m;
  }
}

/** The caller supplies the existing default order, before local page slicing. */
export function sortModelCatalogRows(
  rows: readonly ModelCatalogRow[],
  sort?: ModelCatalogSort,
): readonly ModelCatalogRow[] {
  if (!sort) return rows;
  const key = sort.slice(0, sort.lastIndexOf("_")) as ModelCatalogSortKey;
  const direction = sort.endsWith("_asc") ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: sortValue(row, key) }))
    .sort((left, right) => {
      const leftKnown =
        left.value !== undefined && (typeof left.value !== "number" || Number.isFinite(left.value));
      const rightKnown =
        right.value !== undefined && (typeof right.value !== "number" || Number.isFinite(right.value));
      if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
      let compared = 0;
      if (typeof left.value === "number" && typeof right.value === "number" && leftKnown && rightKnown)
        compared = left.value - right.value;
      else if (typeof left.value === "string" && typeof right.value === "string")
        compared = left.value.localeCompare(right.value);
      // Descending changes the primary value only: unknowns and equal ties never reverse.
      return compared * direction || left.index - right.index;
    })
    .map(({ row }) => row);
}
