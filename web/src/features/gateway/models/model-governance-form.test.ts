import { describe, expect, it } from "vitest";
import {
  contractBody,
  contractSchema,
  contractValues,
  deprecationSchema,
  safeModelTarget,
  trimModelSpace,
} from "./model-governance-form";
import { contractFixture } from "./model-governance-test-fixtures";

describe("고정 모델 계약·패턴 입력", () => {
  it("편집ID는 입력값과 분리하고 blank는기존0의미, false와작은소수는유지한다", () => {
    const parsed = contractSchema.parse({
      ...contractValues(contractFixture),
      name: "새 이름",
      min_quality_score: "",
      max_avg_cost_krw: "0.0000003",
      enabled: false,
    });
    expect(contractBody(parsed, "\uFEFF계약 +/?&#")).toMatchObject({
      id: "\uFEFF계약 +/?&#",
      name: "새 이름",
      min_quality_score: 0,
      max_avg_cost_krw: 0.0000003,
      enabled: false,
    });
    expect(contractBody(parsed)).not.toHaveProperty("id");
  });
  it.each(["1.5", "9007199254740992", "NaN", "Infinity", "-1"])(
    "평균지연 %s를 원치않는 정수로 전송하지 않는다",
    (value) => {
      expect(
        contractSchema.safeParse({ ...contractValues(contractFixture), max_latency_ms: value }).success,
      ).toBe(false);
    },
  );
  it.each(["", " alice", "alice ", "\u0085alice", "alice\u0085", "\ud800"])(
    "계약ID %j는 다른대상으로정규화하지않고 차단한다",
    (id) => {
      expect(safeModelTarget(id, "contract")).toBe(false);
    },
  );
  it.each(["alice", "\uFEFFalice", "한글\u0085\uFEFF +/?&#"])("유효한 정확 계약ID %j는 유지한다", (id) => {
    expect(safeModelTarget(id, "contract")).toBe(true);
  });
  it.each(["", "/target", "target/", ".", "..", "\ud800"])("지원종료 경로 ID %j는 모호하면차단한다", (id) => {
    expect(safeModelTarget(id, "deprecation")).toBe(false);
  });
  it.each(["moddep_1", "한글 +?#&", "a/b", "\u0085target", "\uFEFFtarget"])(
    "정확한 지원종료 ID %j는 변경하지않는다",
    (id) => {
      expect(safeModelTarget(id, "deprecation")).toBe(true);
    },
  );
  it("서버 공백만 정리하고 FEFF와대소문자는pattern body에그대로둔다", () => {
    expect(trimModelSpace(" \u0085\uFEFFOLD-*\u0085 ")).toBe("\uFEFFOLD-*");
    expect(
      deprecationSchema.parse({
        model_glob: " \u0085\uFEFFOLD-*\u0085 ",
        replacement: "",
        sunset_date: "",
        message: "",
      }).model_glob,
    ).toBe("\uFEFFOLD-*");
    expect(deprecationSchema.safeParse({ model_glob: "\u0085" }).success).toBe(false);
  });
  it.each(["2026-02-31", "2026-13-01", "2026-1-01"])(
    "실제 존재하지않는 종료일 %s는 보낸뒤400을기다리지않는다",
    (sunset_date) => {
      expect(deprecationSchema.safeParse({ model_glob: "old-*", sunset_date }).success).toBe(false);
    },
  );
});
