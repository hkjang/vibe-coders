export const providerCatalogSortKeys = ["name", "priority", "timeout"] as const;
export type ProviderCatalogSortKey = (typeof providerCatalogSortKeys)[number];
export type ProviderCatalogSort = `${ProviderCatalogSortKey}_${"asc" | "desc"}`;
export type ProviderCatalogSortOrder = ProviderCatalogSort | readonly ProviderCatalogSort[];
export const providerCatalogSortValues: readonly ProviderCatalogSort[] = providerCatalogSortKeys.flatMap(
  (key) => [`${key}_asc`, `${key}_desc`] as const,
);
export const providerCatalogPageSizes = [10, 25, 50] as const;
export type ProviderCatalogPageSize = (typeof providerCatalogPageSizes)[number];

/** Reject duplicates and coercion rather than choosing an ambiguous URL value. */
export function readProviderCatalogSort(values: readonly string[]): ProviderCatalogSort | undefined {
  return values.length === 1 ? providerCatalogSortValues.find((value) => value === values[0]) : undefined;
}

/** One bounded URL value with ordered, unique columns; single sorts remain valid. */
export function readProviderCatalogSorting(
  values: readonly string[],
): readonly ProviderCatalogSort[] | undefined {
  if (values.length !== 1 || (values[0]?.length ?? 0) > 128) return undefined;
  const parts = values[0]?.split(",") ?? [];
  if (parts.length === 0 || parts.length > providerCatalogSortKeys.length) return undefined;
  const result: ProviderCatalogSort[] = [];
  const columns = new Set<string>();
  for (const part of parts) {
    const sort = readProviderCatalogSort([part]);
    const column = part.slice(0, part.lastIndexOf("_"));
    if (!sort || columns.has(column)) return undefined;
    columns.add(column);
    result.push(sort);
  }
  return result;
}

export function providerCatalogSortList(sort?: ProviderCatalogSortOrder): readonly ProviderCatalogSort[] {
  return typeof sort === "string" ? [sort] : (sort ?? []);
}

export function providerCatalogSortQuery(sort?: ProviderCatalogSortOrder): string | undefined {
  return providerCatalogSortList(sort).join(",") || undefined;
}

export function readProviderCatalogPageSize(values: readonly string[]): ProviderCatalogPageSize | undefined {
  return values.length === 1
    ? providerCatalogPageSizes.find((value) => String(value) === values[0])
    : undefined;
}
