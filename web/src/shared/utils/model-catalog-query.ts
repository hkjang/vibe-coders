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
export type ModelCatalogSortOrder = ModelCatalogSort | readonly ModelCatalogSort[];
export const modelCatalogSortValues: readonly ModelCatalogSort[] = modelCatalogSortKeys.flatMap(
  (key) => [`${key}_asc`, `${key}_desc`] as const,
);
export const modelCatalogPageSizes = [10, 25, 50] as const;
export type ModelCatalogPageSize = (typeof modelCatalogPageSizes)[number];

/** Exact single-value URL contracts: no coercion, trimming or duplicate preference. */
export function readModelCatalogSort(values: readonly string[]): ModelCatalogSort | undefined {
  return values.length === 1 ? modelCatalogSortValues.find((value) => value === values[0]) : undefined;
}

/** One bounded URL value, ordered unique columns. Existing single sorts remain valid. */
export function readModelCatalogSorting(values: readonly string[]): readonly ModelCatalogSort[] | undefined {
  if (values.length !== 1 || (values[0]?.length ?? 0) > 128) return undefined;
  const parts = values[0]?.split(",") ?? [];
  if (parts.length === 0 || parts.length > modelCatalogSortKeys.length) return undefined;
  const result: ModelCatalogSort[] = [];
  const columns = new Set<string>();
  for (const part of parts) {
    const sort = readModelCatalogSort([part]);
    const column = part.slice(0, part.lastIndexOf("_"));
    if (!sort || columns.has(column)) return undefined;
    columns.add(column);
    result.push(sort);
  }
  return result;
}

export function modelCatalogSortList(sort?: ModelCatalogSortOrder): readonly ModelCatalogSort[] {
  return typeof sort === "string" ? [sort] : (sort ?? []);
}

export function modelCatalogSortQuery(sort?: ModelCatalogSortOrder): string | undefined {
  return modelCatalogSortList(sort).join(",") || undefined;
}

export function readModelCatalogPageSize(values: readonly string[]): ModelCatalogPageSize | undefined {
  return values.length === 1 ? modelCatalogPageSizes.find((value) => String(value) === values[0]) : undefined;
}
