import { describe, expect, it } from "vitest";
import {
  incompleteConditions,
  rateLabel,
  simulationAggregate,
  simulationCount,
  simulationSnapshot,
  simulationText,
  unknownSimulationValue,
} from "./policy-simulation-state";

describe("집계값만 보관하는 정책 결과", () => {
  it.each([undefined, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2", null])(
    "잘못된 개수 %s를 0으로 바꾸지 않는다",
    (value) => {
      expect(simulationCount(value)).toBeUndefined();
    },
  );
  it.each([0, 1, 5000, Number.MAX_SAFE_INTEGER])("응답의 유효 정수 %s를 보존한다", (value) => {
    expect(simulationCount(value)).toBe(value);
  });
  it("정의된 집계만 복사하여 raw samples와 unknown 필드를 보관하지 않는다", () => {
    const raw = {
      evaluated: 4,
      sample_blocked: [{ api_key_id: "public_sample" }],
      note: "public_note",
      shadow: { affected_keys: 0, false_positive_sample: [{ team: "public_team" }] },
    };
    const projected = simulationAggregate(raw);
    expect(projected.evaluated).toBe(4);
    expect(projected.keys).toBe(0);
    expect(JSON.stringify(projected)).not.toMatch(/public_|sample|note/u);
    expect(projected).not.toHaveProperty("shadow");
  });
  it("누락·비정상 비율과 비용·날짜는 확정 숫자나 원문으로 표시하지 않는다", () => {
    const result = simulationAggregate({
      evaluated: -1,
      block_rate: 1.1,
      since: "public-invalid-time",
      shadow: { blocked_cost_krw: -10, false_positive_rate: NaN },
    });
    expect(result.evaluated).toBeUndefined();
    expect(result.blockRate).toBeUndefined();
    expect(result.candidateRate).toBeUndefined();
    expect(result.historicalCost).toBeUndefined();
    expect(result.since).toBeUndefined();
  });
  it("분모가 0 또는 누락이면 응답 비율0도 효과 판정으로 표시하지 않는다", () => {
    expect(rateLabel(0, 0)).toBe(unknownSimulationValue);
    expect(rateLabel(0, undefined)).toBe(unknownSimulationValue);
    expect(rateLabel(0, 4)).not.toBe(unknownSimulationValue);
  });
  it("실행한 규칙은 query row의 이후 중첩 변경과 독립적이다", () => {
    const row = {
      id: "public",
      title: "원래 추천",
      conditions: { model: { eq: "A" } },
      actions: { block: true },
    };
    const snapshot = simulationSnapshot(row, "7d");
    row.conditions.model.eq = "B";
    row.title = "새 추천";
    expect(snapshot.title).toBe("원래 추천");
    expect(snapshot.conditions).toEqual({ model: { eq: "A" } });
  });
  it("현재 접두사와 encoded 표현을 표시만 가리고 실행 원문은 유지한다", () => {
    const marker = `corp_${"a".repeat(40)}`;
    expect(simulationText(marker, [])).toBe(marker);
    expect(simulationText(marker, ["corp_"])).not.toContain(marker);
    expect(simulationText(encodeURIComponent(`Bearer ${marker}`), [])).not.toContain(marker);
    const snapshot = simulationSnapshot({ id: "public", conditions: { model: marker }, actions: {} }, "7d");
    expect(snapshot.conditions.model).toBe(marker);
  });
  it("복원 불가 조건/알 수 없는 키의 안내도 현재 접두사로 보호한다", () => {
    const marker = `corp_${"a".repeat(40)}`;
    const snapshot = simulationSnapshot(
      { id: "public", conditions: { cost_krw: 10, contains_secret: false, [marker]: true } },
      "7d",
    );
    expect(incompleteConditions(snapshot, ["corp_"])).toEqual([
      "원화 비용",
      "비밀정보 포함",
      "알 수 없는 조건 (민감정보가 포함될 수 있어 표시하지 않습니다.)",
    ]);
  });
  it("서버가 정규화하는 조건 이름의 표시 분류만 맞추며 원문을 변경하지 않는다", () => {
    const snapshot = simulationSnapshot(
      { id: "public", conditions: { " MODEL ": "A", "\u0085COST_KRW\u0085": 1, "\uFEFFmodel": "B" } },
      "7d",
    );
    expect(incompleteConditions(snapshot, [])).toEqual(["원화 비용", "알 수 없는 조건 (\uFEFFmodel)"]);
    expect(snapshot.conditions).toHaveProperty(" MODEL ", "A");
  });
});
