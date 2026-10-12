import { describe, expect, it } from "vitest";
import type { ProviderCatalogRow } from "./provider-catalog";
import {
  providerCatalogSortFromColumn,
  providerCatalogSortLabel,
  providerCatalogSortState,
  providerTableSortColumns,
  sortProviderCatalogRows,
} from "./provider-table-state";
import {
  providerCatalogSortValues,
  readProviderCatalogPageSize,
  readProviderCatalogSort,
} from "@/shared/utils/provider-catalog-query";

function row(displayName: string, priority = 0, timeout = 0): ProviderCatalogRow {
  return {
    displayName,
    identity: displayName,
    nameRedacted: true,
    health: "unknown",
    provider: {
      name: "[provider-name-omitted]",
      provider_ref: `prv_${"A".repeat(43)}`,
      base_url: "https://example.invalid",
      api_key_configured: false,
      timeout_ms: timeout,
      enabled: true,
      model_patterns: "*",
      failover_group: "",
      priority,
      created_at: "2026-10-12T00:00:00Z",
    },
  };
}
const names = (rows: readonly ProviderCatalogRow[]) => rows.map((item) => item.displayName);

describe("provider local table state", () => {
  it("preserves default order and references without changing the source", () => {
    const rows = [row("z"), row("a")];
    expect(sortProviderCatalogRows(rows)).toBe(rows);
    expect(names(sortProviderCatalogRows(rows, "name_asc"))).toEqual(["a", "z"]);
    expect(names(sortProviderCatalogRows(rows, "name_desc"))).toEqual(["z", "a"]);
    expect(names(rows)).toEqual(["z", "a"]);
  });
  it.each(["priority", "timeout"] as const)("sorts raw %s values with zero and stable equal ties", (key) => {
    const rows = [row("first", 10, 10), row("zero"), row("second", 10, 10), row("negative", -1, -1)];
    expect(names(sortProviderCatalogRows(rows, `${key}_asc`))).toEqual([
      "negative",
      "zero",
      "first",
      "second",
    ]);
    expect(names(sortProviderCatalogRows(rows, `${key}_desc`))).toEqual([
      "first",
      "second",
      "zero",
      "negative",
    ]);
  });
  it.each(["priority", "timeout"] as const)("keeps nonfinite %s values last in either direction", (key) => {
    const rows = [row("unknown", NaN, Infinity), row("zero"), row("positive", 2, 2)];
    expect(names(sortProviderCatalogRows(rows, `${key}_asc`))).toEqual(["zero", "positive", "unknown"]);
    expect(names(sortProviderCatalogRows(rows, `${key}_desc`))).toEqual(["positive", "zero", "unknown"]);
  });
  it("does not use masked raw names or upstream URLs as a sort key", () => {
    const first = row("공급자 1");
    const second = row("공급자 2");
    first.provider.name = "zzz";
    second.provider.name = "aaa";
    expect(sortProviderCatalogRows([first, second], "name_asc")).toEqual([first, second]);
  });
  it("maps only the three supported columns and Korean labels", () => {
    expect(providerTableSortColumns.map((column) => column.id)).toEqual(["provider", "failover", "timeout"]);
    for (const sort of providerCatalogSortValues) {
      const state = providerCatalogSortState(sort);
      expect(state).toBeDefined();
      if (state) expect(providerCatalogSortFromColumn(state.columnId, state.direction)).toBe(sort);
      expect(providerCatalogSortLabel(sort)).toMatch(/(오름차순|내림차순)$/);
    }
    expect(providerCatalogSortFromColumn("latency", "asc")).toBeUndefined();
    expect(providerCatalogSortState()).toBeUndefined();
    expect(providerCatalogSortLabel()).toBe("기본 순서 (우선순위·공급자 이름)");
  });
  it("parses exact single values without duplicate preference or coercion", () => {
    for (const sort of providerCatalogSortValues) expect(readProviderCatalogSort([sort])).toBe(sort);
    for (const value of [[], ["name"], [" name_asc"], ["name_asc", "name_asc"]])
      expect(readProviderCatalogSort(value)).toBeUndefined();
    for (const size of [10, 25, 50]) expect(readProviderCatalogPageSize([String(size)])).toBe(size);
    for (const value of [[], ["010"], ["25.0"], ["25", "50"]])
      expect(readProviderCatalogPageSize(value)).toBeUndefined();
  });
});
