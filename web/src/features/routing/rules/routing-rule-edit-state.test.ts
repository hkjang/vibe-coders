import { describe, expect, it } from "vitest";
import type { RoutingRule } from "@/shared/api/domains/routing";
import {
  assertRuleBaseline,
  buildRulePatch,
  editIdentityReason,
  RuleEditProblem,
  ruleAcknowledged,
  ruleText,
} from "./routing-rule-edit-state";

const original: RoutingRule = {
  id: "routing-review",
  enabled: true,
  priority: 10,
  match_pattern: "*",
  min_complexity: 10,
  max_complexity: 80,
  target_model: "model-a",
  target_provider: "provider-a",
  note: "원래 메모",
  created_at: "2026-10-01T00:00:00.123456789Z",
};

describe("라우팅 규칙 편집의 명시 변경 의도", () => {
  it("변경하지 않은 값과 정규화 뒤 같은 값은 보내지 않는다", () => {
    expect(buildRulePatch(original, {}, [])).toEqual({});
    expect(
      buildRulePatch(original, { note: original.note, priority: "010", match_pattern: "  " }, []),
    ).toEqual({});
  });

  it("빈값 지우기와 숫자 0을 실제 변경으로 보존하되 ID와 사용 상태는 보내지 않는다", () => {
    expect(buildRulePatch(original, { note: "", target_provider: "", min_complexity: "0" }, [])).toEqual({
      note: "",
      target_provider: "",
      min_complexity: 0,
    });
    expect(buildRulePatch(original, { target_model: " model-b " }, [])).toEqual({ target_model: "model-b" });
  });

  it("Go TrimSpace와 동일하게 NEL은 제거하고 FEFF는 유지한다", () => {
    expect(buildRulePatch(original, { note: "\u0085새 메모\u0085" }, [])).toEqual({ note: "새 메모" });
    expect(buildRulePatch(original, { note: "\ufeff새 메모\ufeff" }, [])).toEqual({
      note: "\ufeff새 메모\ufeff",
    });
  });

  it.each(["", " ", "0", "-1", "1.5", "10001", "Infinity", "9007199254740992", "not-a-number"])(
    "유효하지 않은 우선순위 %j는 해당 필드 오류다",
    (priority) => {
      try {
        buildRulePatch(original, { priority }, []);
        expect.unreachable("잘못된 우선순위를 허용했습니다.");
      } catch (error) {
        expect(error).toBeInstanceOf(RuleEditProblem);
        expect(error).toMatchObject({ field: "priority" });
      }
    },
  );

  it("함께 병합한 복잡도 범위를 검사하고 정상적인 양쪽 변경은 허용한다", () => {
    expect(() => buildRulePatch(original, { min_complexity: "81" }, [])).toThrow(RuleEditProblem);
    expect(() => buildRulePatch(original, { max_complexity: "9" }, [])).toThrow(RuleEditProblem);
    expect(buildRulePatch(original, { min_complexity: "90", max_complexity: "100" }, [])).toEqual({
      min_complexity: 90,
      max_complexity: 100,
    });
  });

  it("모델의 공백값과 문자열 한도를 검증한다", () => {
    expect(() => buildRulePatch(original, { target_model: "\u0085 " }, [])).toThrow(RuleEditProblem);
    expect(() => buildRulePatch(original, { match_pattern: "x".repeat(201) }, [])).toThrow(RuleEditProblem);
    expect(() => buildRulePatch(original, { target_provider: "x".repeat(121) }, [])).toThrow(RuleEditProblem);
    expect(() => buildRulePatch(original, { note: "x".repeat(501) }, [])).toThrow(RuleEditProblem);
  });

  it("보호된 기존 원문은 생략으로 유지하고 명시 지우기·안전한 교체만 전송한다", () => {
    const secret = `public_private_${"s".repeat(48)}`;
    const baseline = { ...original, note: secret };
    const prefixes = ["public_private_"];
    expect(ruleText(secret, prefixes)).not.toContain(secret);
    expect(buildRulePatch(baseline, { target_model: "model-b" }, prefixes)).toEqual({
      target_model: "model-b",
    });
    expect(buildRulePatch(baseline, { note: "" }, prefixes)).toEqual({ note: "" });
    expect(buildRulePatch(baseline, { note: "새 공개 메모" }, prefixes)).toEqual({ note: "새 공개 메모" });
    expect(() => buildRulePatch(original, { note: secret }, prefixes)).toThrow(RuleEditProblem);
  });

  it("전체 검토 기준이 바뀌거나 선택 ID가 없거나 중복이면 거부한다", () => {
    expect(() => assertRuleBaseline([original], original)).not.toThrow();
    for (const rows of [
      [],
      [original, original],
      [{ ...original, enabled: false }],
      [{ ...original, created_at: "2026-10-01T00:00:01Z" }],
    ]) {
      expect(() => assertRuleBaseline(rows, original)).toThrow();
    }
    for (const id of ["", ".", "..", "part/other"])
      expect(editIdentityReason({ ...original, id })).toBeDefined();
  });

  it("저장 ACK는 원래 ID와 명시 변경을 확인하며 미편집 필드의 경쟁 변경은 실패로 오인하지 않는다", () => {
    const patch = { target_model: "model-b" };
    expect(
      ruleAcknowledged({ ...original, ...patch, enabled: false, note: "다른 변경" }, original, patch),
    ).toBe(true);
    expect(ruleAcknowledged({ ...original, ...patch, id: "different-id" }, original, patch)).toBe(false);
    expect(ruleAcknowledged(original, original, patch)).toBe(false);
  });
});
