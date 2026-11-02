import type { ModelCatalogRow } from "./model-catalog";
import {
  modelCatalogSortList,
  type ModelCatalogSort,
  type ModelCatalogSortKey,
  type ModelCatalogSortOrder,
} from "@/shared/utils/model-catalog-query";

export function defaultModelCatalogOrder(left: ModelCatalogRow, right: ModelCatalogRow): number {
  return (
    left.providerLabel.localeCompare(right.providerLabel) ||
    left.model.id.localeCompare(right.model.id) ||
    left.model.source.localeCompare(right.model.source)
  );
}

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

export function modelCatalogSortLabel(sort?: ModelCatalogSortOrder): string {
  const criteria = modelCatalogSortList(sort);
  if (criteria.length === 0) return "기본 순서 (공급자·모델·출처)";
  return criteria
    .map((criterion) => {
      const key = criterion.slice(0, criterion.lastIndexOf("_")) as ModelCatalogSortKey;
      return `${sortColumns[key].label} ${criterion.endsWith("_asc") ? "오름차순" : "내림차순"}`;
    })
    .join(" → ");
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
  sort?: ModelCatalogSortOrder,
): readonly ModelCatalogRow[] {
  const criteria = modelCatalogSortList(sort).map((criterion) => ({
    key: criterion.slice(0, criterion.lastIndexOf("_")) as ModelCatalogSortKey,
    direction: criterion.endsWith("_asc") ? 1 : -1,
  }));
  if (criteria.length === 0) return rows;
  return rows
    .map((row, index) => ({ row, index, values: criteria.map(({ key }) => sortValue(row, key)) }))
    .sort((left, right) => {
      for (const [index, { direction }] of criteria.entries()) {
        const leftValue = left.values[index];
        const rightValue = right.values[index];
        const leftKnown =
          leftValue !== undefined && (typeof leftValue !== "number" || Number.isFinite(leftValue));
        const rightKnown =
          rightValue !== undefined && (typeof rightValue !== "number" || Number.isFinite(rightValue));
        if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
        let compared = 0;
        if (typeof leftValue === "number" && typeof rightValue === "number" && leftKnown && rightKnown)
          compared = leftValue - rightValue;
        else if (typeof leftValue === "string" && typeof rightValue === "string")
          compared = leftValue.localeCompare(rightValue);
        if (compared) return compared * direction;
      }
      // All equal (including unknowns): retain the deterministic default order.
      return left.index - right.index;
    })
    .map(({ row }) => row);
}
