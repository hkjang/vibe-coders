export const providerCatalogSortKeys = ["name", "priority", "timeout"] as const;
export type ProviderCatalogSortKey = (typeof providerCatalogSortKeys)[number];
export type ProviderCatalogSort = `${ProviderCatalogSortKey}_${"asc" | "desc"}`;
export const providerCatalogSortValues: readonly ProviderCatalogSort[] = providerCatalogSortKeys.flatMap(
  (key) => [`${key}_asc`, `${key}_desc`] as const,
);
export const providerCatalogPageSizes = [10, 25, 50] as const;
export type ProviderCatalogPageSize = (typeof providerCatalogPageSizes)[number];

/** Reject duplicates and coercion rather than choosing an ambiguous URL value. */
export function readProviderCatalogSort(values: readonly string[]): ProviderCatalogSort | undefined {
  return values.length === 1 ? providerCatalogSortValues.find((value) => value === values[0]) : undefined;
}

export function readProviderCatalogPageSize(values: readonly string[]): ProviderCatalogPageSize | undefined {
  return values.length === 1
    ? providerCatalogPageSizes.find((value) => String(value) === values[0])
    : undefined;
}
