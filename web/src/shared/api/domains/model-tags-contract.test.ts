import { describe, expect, it } from "vitest";
import type { ModelUsageTagWriteBody } from "./gateway";
import { modelUsageTagDeleteSchema, modelUsageTagWriteSchema } from "./gateway.schemas";

const row = {
  model: "\ufeffpublic-model",
  good_for: " sql, code ",
  avoid_for: "",
  risk_note: "public note",
  updated_by: "public-operator",
  updated_at: "2026-09-30T01:00:00.123456789Z",
};

describe("model tag mutation contracts", () => {
  it("preserves the complete returned row and opaque identifier without client trimming", () => {
    expect(modelUsageTagWriteSchema.parse(row)).toEqual(row);
  });

  it("rejects incomplete, null or malformed acknowledgments instead of inventing saved values", () => {
    for (const value of [
      null,
      {},
      { model: row.model },
      { ...row, model: "" },
      { ...row, good_for: null },
      { ...row, updated_by: undefined },
      { ...row, updated_at: "not-a-time" },
      { ...row, unknown: "not-in-the-contract" },
    ]) {
      expect(modelUsageTagWriteSchema.safeParse(value).success).toBe(false);
    }
  });

  it("keeps generated nullable request fields separate from the non-null response", () => {
    const body = {
      model: row.model,
      good_for: null,
      avoid_for: null,
      risk_note: null,
    } satisfies ModelUsageTagWriteBody;
    expect(body).toEqual({ model: row.model, good_for: null, avoid_for: null, risk_note: null });
  });

  it("accepts only the existing deleted acknowledgment, which does not prove a row existed", () => {
    expect(modelUsageTagDeleteSchema.parse({ status: "deleted" })).toEqual({ status: "deleted" });
    for (const value of [null, {}, { status: "ok" }, { status: "deleted", count: 1 }]) {
      expect(modelUsageTagDeleteSchema.safeParse(value).success).toBe(false);
    }
  });
});
