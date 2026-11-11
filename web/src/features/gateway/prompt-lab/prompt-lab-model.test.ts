import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import { labReceipt } from "../../../../tests/fixtures/prompt-lab";
import {
  labExecutionModels,
  labIDAllowed,
  projectHistory,
  projectRun,
  safeLabError,
} from "./prompt-lab-model";
describe("프롬프트 실험실 응답과 실행 모델", () => {
  it("matches server trim, deduplication and five-model cap", () => {
    expect(labExecutionModels('[" a ","a","","b","c","d","e","f"]')).toEqual(["a", "b", "c", "d", "e"]);
    for (const value of [null, "", "{}", "[1]", "[]", '[" "]'])
      expect(labExecutionModels(value)).toBeUndefined();
  });
  it("rejects unsafe IDs before they enter navigation or requests", () => {
    for (const value of ["", " a", "a\nb", `corp_${"x".repeat(36)}`])
      expect(labIDAllowed(value, ["corp_"])).toBe(false);
    expect(labIDAllowed("public_run", ["corp_"])).toBe(true);
  });
  it("rejects incomplete, duplicated or unexpected model receipts", () => {
    for (const value of [
      { ...labReceipt, status: "running" },
      { ...labReceipt, run_id: null },
      { ...labReceipt, model_count: 0 },
      { ...labReceipt, best_model: "another" },
      { ...labReceipt, results: [] },
      { ...labReceipt, results: [{ ...labReceipt.results[0], model: "another" }] },
      { ...labReceipt, model_count: 2, results: [...labReceipt.results, ...labReceipt.results] },
    ])
      expect(() => projectRun(value, [], ["public-model-a"])).toThrow();
  });
  it("drops echoed prompts and response data while preserving zero and missing metrics", () => {
    const value = {
      ...labReceipt,
      response: "public-response",
      results: [
        { ...labReceipt.results[0], score: null, response: "public-response", prompt: "public-prompt" },
      ],
    };
    const projected = projectRun(value, [], ["public-model-a"]);
    expect(projected.results[0]?.score).toBeNull();
    expect(projected.results[0]?.cost_krw).toBe(0);
    expect(JSON.stringify(projected)).not.toContain("public-response");
    expect(JSON.stringify(projected)).not.toContain("public-prompt");
    expect(projected.history).toEqual([]);
  });
  it("projects history and errors without retaining configured credentials", () => {
    const secret = `corp_${"x".repeat(36)}`;
    const history = projectHistory(
      [{ ...labReceipt.history[0], best_model: secret, extra: secret }],
      ["corp_"],
    );
    expect(JSON.stringify(history)).not.toContain(secret);
    const error = safeLabError(
      new AppError(secret, { kind: "http", status: 500, requestId: secret, details: { raw: secret } }),
      ["corp_"],
    );
    expect(error.requestId).toBeUndefined();
    expect(error.details).toBeUndefined();
    expect(error.message).not.toContain(secret);
  });
});
