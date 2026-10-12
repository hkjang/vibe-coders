import { describe, expect, it } from "vitest";

import { modelRowKey, type ModelCatalogRow } from "./model-catalog";
import {
  modelCatalogSortFromColumn,
  modelCatalogSortLabel,
  modelCatalogSortState,
  observedModelSuccessRate,
  sortModelCatalogRows,
} from "./model-catalog-table-state";
import {
  modelCatalogSortValues,
  readModelCatalogPageSize,
  readModelCatalogSort,
} from "@/shared/utils/model-catalog-query";

function row(id: string, overrides: Partial<ModelCatalogRow> = {}): ModelCatalogRow {
  return {
    model: {
      created: 1_700_000_000,
      deprecation: null,
      fetched_at: "2026-10-08T00:00:00Z",
      id,
      object: "model",
      owned_by: "vendor",
      provider: "provider",
      provider_ref: `prv_${"A".repeat(43)}`,
      shadowed: false,
      shadowed_by: "",
      source: "live",
      stale: false,
      virtual: false,
    },
    providerLabel: "공급자",
    status: "available",
    ...overrides,
  };
}

function quality(requests: number, successRate: number, score = 50): NonNullable<ModelCatalogRow["quality"]> {
  return {
    categories: {},
    eval_pass_rate: 0,
    eval_samples: 0,
    golden_pass_rate: 0,
    golden_samples: 0,
    model: "fixture",
    quality_score: score,
    requests,
    success_rate: successRate,
  };
}

function price(input: number, output = input): NonNullable<ModelCatalogRow["price"]> {
  return { input_krw_per_1m: input, output_krw_per_1m: output, cached_input_krw_per_1m: 0 };
}

const ids = (rows: readonly ModelCatalogRow[]) => rows.map((entry) => entry.model.id);

describe("model catalogue local table state", () => {
  it("leaves the original compound default order and array untouched", () => {
    const rows = [row("z"), row("a")];
    expect(sortModelCatalogRows(rows)).toBe(rows);
    const sorted = sortModelCatalogRows(rows, "model_asc");
    expect(ids(sorted)).toEqual(["a", "z"]);
    expect(ids(rows)).toEqual(["z", "a"]);
    expect(sorted[0]).toBe(rows[1]);
    expect(sorted[1]).toBe(rows[0]);
  });

  it("sorts the complete received list before any page slice using raw numeric prices", () => {
    const rows = Array.from({ length: 60 }, (_, index) => row(`base-${index}`, { price: price(index + 2) }));
    rows.push(row("last-free", { price: price(0, 0.1) }));
    expect(ids(sortModelCatalogRows(rows, "input_price_asc").slice(0, 3))).toEqual([
      "last-free",
      "base-0",
      "base-1",
    ]);
    expect(sortModelCatalogRows(rows, "input_price_desc")[0]).toBe(rows[59]);
    expect(
      ids(
        sortModelCatalogRows(
          [row("ten", { price: price(10, 0.2) }), row("two", { price: price(2, 0.11) })],
          "output_price_asc",
        ),
      ),
    ).toEqual(["two", "ten"]);
  });

  it.each(["input_price", "output_price", "quality"] as const)(
    "%s keeps legitimate zero values before missing values in both directions",
    (key) => {
      const rows = [
        row("missing"),
        row("zero", { price: price(0), quality: quality(1, 0, 0) }),
        row("positive", { price: price(10), quality: quality(1, 1, 10) }),
      ];
      expect(ids(sortModelCatalogRows(rows, `${key}_asc`))).toEqual(["zero", "positive", "missing"]);
      expect(ids(sortModelCatalogRows(rows, `${key}_desc`))).toEqual(["positive", "zero", "missing"]);
    },
  );

  it("treats no request samples as unknown without losing valid eval-only quality", () => {
    const evalOnly = row("eval-only", {
      quality: { ...quality(0, 0, 90), eval_samples: 4, eval_pass_rate: 1 },
    });
    const failed = row("observed-zero", { quality: quality(5, 0, 0) });
    const success = row("observed-success", { quality: quality(5, 0.8, 80) });
    const missing = row("missing");
    const rows = [evalOnly, failed, success, missing];
    expect(observedModelSuccessRate(evalOnly)).toBeUndefined();
    expect(observedModelSuccessRate(missing)).toBeUndefined();
    expect(observedModelSuccessRate(failed)).toBe(0);
    expect(ids(sortModelCatalogRows(rows, "success_asc"))).toEqual([
      "observed-zero",
      "observed-success",
      "eval-only",
      "missing",
    ]);
    expect(ids(sortModelCatalogRows(rows, "success_desc"))).toEqual([
      "observed-success",
      "observed-zero",
      "eval-only",
      "missing",
    ]);
    expect(sortModelCatalogRows(rows, "quality_desc")[0]).toBe(evalOnly);
  });

  it.each(["asc", "desc"] as const)("preserves equal-value and missing-value ties when %s", (direction) => {
    const rows = [
      row("unknown-a"),
      row("equal-a", { price: price(2) }),
      row("unknown-b"),
      row("equal-b", { price: price(2) }),
    ];
    expect(ids(sortModelCatalogRows(rows, `input_price_${direction}`))).toEqual([
      "equal-a",
      "equal-b",
      "unknown-a",
      "unknown-b",
    ]);
  });

  it("retains provider/source identity for equal model IDs rather than collapsing rows", () => {
    const first = row("same");
    const second: ModelCatalogRow = { ...first, model: { ...first.model, source: "cache" } };
    const third = { ...first, model: { ...first.model, provider_ref: `prv_${"B".repeat(43)}` } };
    const rows = [first, second, third];
    const sorted = sortModelCatalogRows(rows, "model_desc");
    expect(sorted).toEqual(rows);
    expect(new Set(sorted.map((entry) => modelRowKey(entry.model))).size).toBe(3);
  });

  it("compares displayed provider labels while keeping equal labels in their original order", () => {
    const rows = [
      row("second", { providerLabel: "Zulu" }),
      row("first", { providerLabel: "Alpha" }),
      row("third", { providerLabel: "Zulu" }),
    ];
    expect(ids(sortModelCatalogRows(rows, "provider_asc"))).toEqual(["first", "second", "third"]);
    expect(ids(sortModelCatalogRows(rows, "provider_desc"))).toEqual(["second", "third", "first"]);
  });

  it("defensively leaves nonfinite helper input with missing values rather than claiming it is zero", () => {
    const rows = [
      row("nan", { price: price(Number.NaN) }),
      row("infinity", { price: price(Infinity) }),
      row("zero", { price: price(0) }),
      row("missing"),
    ];
    expect(ids(sortModelCatalogRows(rows, "input_price_desc"))).toEqual([
      "zero",
      "nan",
      "infinity",
      "missing",
    ]);
  });

  it("round-trips every allowed single-column sort and uses Korean summary labels", () => {
    for (const sort of modelCatalogSortValues) {
      const state = modelCatalogSortState(sort);
      expect(state).toBeDefined();
      if (!state) throw new Error("Expected a configured sort state");
      expect(modelCatalogSortFromColumn(state.columnId, state.direction)).toBe(sort);
      expect(modelCatalogSortLabel(sort)).toMatch(/(오름차순|내림차순)$/u);
    }
    expect(modelCatalogSortState()).toBeUndefined();
    expect(modelCatalogSortFromColumn("unconfigured", "asc")).toBeUndefined();
    expect(modelCatalogSortLabel()).toBe("기본 순서 (공급자·모델·출처)");
  });

  it("parses exact singleton sort and page-size enums only", () => {
    for (const sort of modelCatalogSortValues) expect(readModelCatalogSort([sort])).toBe(sort);
    for (const size of [10, 25, 50]) expect(readModelCatalogPageSize([String(size)])).toBe(size);
    for (const values of [[], ["model_asc", "model_asc"], [" model_asc"], ["default"], ["price_desc"]])
      expect(readModelCatalogSort(values)).toBeUndefined();
    for (const values of [[], ["25", "25"], ["025"], ["25 "], ["100"], ["1e1"]])
      expect(readModelCatalogPageSize(values)).toBeUndefined();
  });
});
