import { describe, expect, it } from "vitest";
import type { Policy } from "@/shared/api/domains/governance";
import { editorJson, editorText, goTrim, protectedJson } from "./policy-editor-security";
import {
  acknowledged,
  buildPolicy,
  changed,
  initialEdit,
  newRule,
  policyProblem,
} from "./policy-editor-state";

function must<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("missing public fixture");
  return value;
}
const base = (): Policy => ({
  id: "policy",
  name: "정책",
  description: "설명",
  enabled: false,
  priority: 10,
  rollout_percent: 37,
  rules: [
    {
      id: "rule",
      name: "규칙",
      enabled: true,
      priority: -2,
      conditions: { contains_secret: true, future: { MixedCase: [1, null, false] } },
      actions: { secret_action: "mask" },
    },
  ],
});
describe("원본 보존과 실제 whole-upsert 계약", () => {
  it("미편집 rule ID/중첩 필드/음수 우선순위/적용 비율을 유지하고 no-change를 구분한다", () => {
    const source = base();
    const body = buildPolicy(source, initialEdit(source), []);
    expect(body.rules).toEqual(source.rules);
    expect(body.rollout_percent).toBe(37);
    expect(changed(source, body)).toBe(false);
  });
  it("원본을 바꾸지 않고 새 규칙에는 ID를 보내지 않는다", () => {
    const source = base();
    const edit = initialEdit(source);
    edit.rules.push(newRule(1));
    const body = buildPolicy(source, edit, []);
    expect(body.rules[1]).not.toHaveProperty("id");
    expect(source.rules).toHaveLength(1);
  });
  it("명시적 전체 삭제 확인 전에는 비우지 않는다", () => {
    const source = base();
    const edit = initialEdit(source);
    must(edit.rules[0]).removed = true;
    expect(() => buildPolicy(source, edit, [])).toThrow("명시적으로 확인");
    edit.emptyConfirmed = true;
    expect(buildPolicy(source, edit, []).rules).toEqual([]);
  });
  it("실제 Go omitempty의 GET/ACK rules 생략만 빈 목록으로 허용한다", () => {
    const source = base();
    delete source.rules;
    expect(policyProblem(source)).toBeUndefined();
    const body = buildPolicy(source, initialEdit(source), []);
    expect(body.rules).toEqual([]);
    expect(changed(source, body)).toBe(false);
    expect(acknowledged(source, body)).toBe(true);
  });
  it("rules null은 omitempty와 다르므로 GET/ACK 모두 거부한다", () => {
    const source = { ...base(), rules: null };
    expect(policyProblem(source)).toBeDefined();
    expect(acknowledged(source, buildPolicy(base(), initialEdit(base()), []))).toBe(false);
  });
  for (const field of ["name", "description", "priority", "enabled", "rollout_percent"] as const) {
    it(`${field} 누락을 기본값으로 추정하지 않는다`, () => {
      const source = base();
      Reflect.deleteProperty(source, field);
      expect(policyProblem(source)).toBeDefined();
    });
  }
  for (const value of ["", "0", "1.5", "NaN", "Infinity", "9007199254740992"]) {
    it(`우선순위 ${value || "빈값"}의 서버 기본값 변환을 막는다`, () => {
      const source = base();
      const edit = initialEdit(source);
      edit.priority = value;
      expect(() => buildPolicy(source, edit, [])).toThrow("안전한 정수");
    });
  }
  it("Go 공백 NEL을 정리하되 FEFF는 보존하고 빈 이름은 원 ID로 검토한다", () => {
    expect(goTrim("\u0085 value \u0085")).toBe("value");
    expect(goTrim("\ufeffvalue\ufeff")).toBe("\ufeffvalue\ufeff");
    const source = base();
    const edit = initialEdit(source);
    edit.name.replacement = "\u0085";
    expect(buildPolicy(source, edit, []).name).toBe(source.id);
  });
  it("trim될 정책 ID는 막고 trim될 규칙 ID는 전체 교체/삭제로 해결할 수 있다", () => {
    expect(policyProblem({ ...base(), id: " id " })).toMatch(/ID/u);
    const source = base();
    must(source.rules?.[0]).id = " rule ";
    const edit = initialEdit(source);
    expect(() => buildPolicy(source, edit, [])).toThrow("규칙 ID");
    edit.rules[0] = newRule(0);
    expect(buildPolicy(source, edit, []).rules[0]).not.toHaveProperty("id");
  });
  it("서버에서 충돌할 최상위 키는 교체 전까지 막되 unknown 중첩 키는 보존한다", () => {
    const source = base();
    must(source.rules?.[0]).conditions = { " Model ": "a", model: "b" };
    const edit = initialEdit(source);
    expect(() => buildPolicy(source, edit, [])).toThrow("최상위 키");
    must(edit.rules[0]).conditions.replacement = '{"model":"b","unknown":{"Upper Label":7}}';
    expect(must(buildPolicy(source, edit, []).rules[0]).conditions).toEqual({
      model: "b",
      unknown: { "Upper Label": 7 },
    });
  });
  for (const value of ["null", "[]", "1", '{"n":1e400}', '{"n":9007199254740993}', "{"]) {
    it(`JSON 입력 ${value} 오류는 원문 없이 거부한다`, () => {
      const source = base();
      const edit = initialEdit(source);
      must(edit.rules[0]).conditions.replacement = value;
      expect(() => buildPolicy(source, edit, [])).toThrow();
    });
  }
  it("ACK는 ID/비활성/변경값을 확인하지만 서버시각은 일치 조건으로 쓰지 않는다", () => {
    const source = base();
    const body = buildPolicy(source, initialEdit(source), []);
    expect(acknowledged({ ...source, created_at: "later", updated_at: "zero" }, body)).toBe(true);
    expect(acknowledged({ ...source, enabled: true }, body)).toBe(false);
    expect(acknowledged({ ...source, id: "other" }, body)).toBe(false);
    expect(acknowledged({ ...source, name: "other" }, body)).toBe(false);
  });
  for (const id of [undefined, "", " new-id ", "rule"]) {
    it(`신규 규칙 ACK의 ${String(id)} ID는 저장 완료로 인정하지 않는다`, () => {
      const source = base();
      const edit = initialEdit(source);
      edit.rules.push(newRule(1));
      const body = buildPolicy(source, edit, []);
      expect(
        acknowledged(
          { ...source, rules: [{ ...must(body.rules[0]) }, { ...must(body.rules[1]), id }] },
          body,
        ),
      ).toBe(false);
    });
  }
});
describe("정책 JSON 의미를 유지하는 로컬 표시 보호", () => {
  const marker = `corp_${"synthetic".repeat(6)}`;
  it("실제 정책 키 contains_secret/secret_type/secret_action의 정상 값은 편집 가능하다", () => {
    expect(protectedJson({ contains_secret: true, secret_type: "pii", secret_action: "block" }, [])).toBe(
      false,
    );
  });
  for (const key of ["contains_secret", "secret_type", "secret_action", "unknown"]) {
    it(`${key} 예외 아래 문자열도 항상 검사한다`, () => {
      expect(protectedJson({ [key]: { nested: [marker] } }, ["corp_"])).toBe(true);
    });
  }
  for (const key of ["password", "token", "auth", "secret_mask", "secret_block"]) {
    it(`알 수 없는 credential 키 ${key}는 예외로 확장하지 않는다`, () => {
      expect(protectedJson({ [key]: "public" }, [])).toBe(true);
    });
  }
  it("키 자체의 credential 접두사도 검사한다", () => {
    expect(protectedJson({ [marker]: false }, ["corp_"])).toBe(true);
  });
  it("현재 접두사 변경은 표시를 바꾸지만 원본과 저장 본문은 바꾸지 않는다", () => {
    const source = base();
    must(source.rules?.[0]).conditions = { model: marker };
    expect(editorJson(must(source.rules?.[0]).conditions, [])).toContain(marker);
    expect(editorJson(must(source.rules?.[0]).conditions, ["corp_"])).not.toContain(marker);
    expect(editorText(marker, ["corp_"])).not.toContain(marker);
    expect(must(buildPolicy(source, initialEdit(source), ["corp_"]).rules[0]).conditions).toEqual({
      model: marker,
    });
  });
  it("원래 보호값은 유지하되 새 민감값 교체는 막고 빈 안전객체 교체는 허용한다", () => {
    const source = base();
    must(source.rules?.[0]).conditions = { token: marker };
    const edit = initialEdit(source);
    expect(must(buildPolicy(source, edit, ["corp_"]).rules[0]).conditions).toEqual({ token: marker });
    must(edit.rules[0]).conditions.replacement = JSON.stringify({ model: marker });
    expect(() => buildPolicy(source, edit, ["corp_"])).toThrow("새 민감정보");
    must(edit.rules[0]).conditions.replacement = "{}";
    expect(must(buildPolicy(source, edit, ["corp_"]).rules[0]).conditions).toEqual({});
  });
});
