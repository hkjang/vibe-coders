export const modelCatalogSortKeys = [
  "model",
  "provider",
  "quality",
  "success",
  "input_price",
  "output_price",
] as const;

export type ModelCatalogSortKey = (typeof modelCatalogSortKeys)[number];
export type ModelCatalogSort = `${ModelCatalogSortKey}_${"asc" | "desc"}`;
export const modelCatalogSortValues: readonly ModelCatalogSort[] = modelCatalogSortKeys.flatMap(
  (key) => [`${key}_asc`, `${key}_desc`] as const,
);
export const modelCatalogPageSizes = [10, 25, 50] as const;
export type ModelCatalogPageSize = (typeof modelCatalogPageSizes)[number];

/** Exact single-value URL contracts: no coercion, trimming or duplicate preference. */
export function readModelCatalogSort(values: readonly string[]): ModelCatalogSort | undefined {
  return values.length === 1 ? modelCatalogSortValues.find((value) => value === values[0]) : undefined;
}

export function readModelCatalogPageSize(values: readonly string[]): ModelCatalogPageSize | undefined {
  return values.length === 1 ? modelCatalogPageSizes.find((value) => String(value) === values[0]) : undefined;
}
