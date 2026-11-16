import { describe, expect, it } from "vitest";
import { comparisonRequest as request } from "./request-comparison-fixtures";
import { requestComparisonMetrics } from "./request-comparison-metrics";

describe("request comparison metrics", () => {
  it("separates each token category and gives signed direction with meaningful units", () => {
    const left = {
      ...request("a"),
      latency_ms: 1000,
      first_chunk_ms: 500,
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cached_tokens: 20,
      reasoning_tokens: 0,
    };
    const right = {
      ...request("b"),
      latency_ms: 1201,
      first_chunk_ms: 450,
      prompt_tokens: 90,
      completion_tokens: 70,
      total_tokens: 160,
      cached_tokens: 10,
      reasoning_tokens: 5,
    };
    const rows = requestComparisonMetrics(left, right, []);
    expect(rows.find((row) => row.label === "전체 지연")).toMatchObject({
      left: "1,000 ms",
      right: "1,201 ms",
      change: "201 ms 증가",
      state: "different",
    });
    expect(rows.find((row) => row.label === "첫 청크 지연")?.change).toBe("50 ms 감소");
    expect(rows.filter((row) => row.label.endsWith("토큰")).map((row) => row.change)).toEqual([
      "10 토큰 감소",
      "20 토큰 증가",
      "10 토큰 증가",
      "10 토큰 감소",
      "5 토큰 증가",
    ]);
  });
  it("compares the API values, not their rounded display strings", () => {
    const rows = requestComparisonMetrics(
      { ...request("a"), estimated_cost: 0.00000111, currency: "USD" },
      { ...request("b"), estimated_cost: 0.00000112, currency: "USD" },
      [],
    );
    const cost = rows.find((row) => row.label === "추정 비용");
    expect(cost?.left).toBe(cost?.right);
    expect(cost?.state).toBe("different");
    expect(cost?.change).toContain("e-8 USD 증가");
    expect(cost?.leftExact).toBe("0.00000111 USD");
    expect(cost?.rightExact).toBe("0.00000112 USD");
  });
  it("refuses to subtract different or unknown currencies even when amounts are equal", () => {
    for (const currency of ["KRW", "", "[값 비공개]"]) {
      const cost = requestComparisonMetrics(
        { ...request("a"), estimated_cost: 10, currency: "USD" },
        { ...request("b"), estimated_cost: 10, currency },
        [],
      ).find((row) => row.label === "추정 비용");
      expect(cost?.state).toBe("unavailable");
      expect(cost?.change).toContain("비교 제외");
    }
  });
  it("handles zero baselines and small negative differences without a fabricated percentage", () => {
    const rows = requestComparisonMetrics(
      { ...request("a"), estimated_cost: 0.0000009 },
      { ...request("b"), estimated_cost: 0, prompt_tokens: 1 },
      [],
    );
    expect(rows.find((row) => row.label === "추정 비용")?.change).toBe("9.0000e-7 KRW 감소");
    expect(rows.find((row) => row.label === "입력 토큰")?.change).toBe("1 토큰 증가");
    expect(JSON.stringify(rows)).not.toMatch(/Infinity|NaN|%/);
  });
  it("does not compare private labels or non-streaming first-chunk values", () => {
    const secret = `corp_${"x".repeat(32)}`;
    const rows = requestComparisonMetrics(
      { ...request("a"), model: secret, currency: `corp_${"s".repeat(32)}`, stream: false },
      { ...request("b"), model: secret, currency: `corp_${"s".repeat(32)}` },
      ["corp_"],
    );
    expect(rows.find((row) => row.label === "모델")).toMatchObject({
      left: "[값 비공개]",
      state: "unavailable",
    });
    expect(rows.find((row) => row.label === "첫 청크 지연")).toMatchObject({
      left: "비스트리밍 요청",
      state: "unavailable",
    });
    expect(rows.find((row) => row.label === "추정 비용")?.state).toBe("unavailable");
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(JSON.stringify(rows)).not.toContain(`corp_${"s".repeat(32)}`);
  });
});
