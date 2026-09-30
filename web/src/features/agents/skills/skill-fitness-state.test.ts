import { describe, expect, it } from "vitest";

import {
  confirmedFitness,
  emptyFitnessForm,
  exactFitnessSkillName,
  fitnessBody,
  fitnessFormSchema,
  fitnessKindLabel,
} from "./skill-fitness-state";
import { skillFitnessRecordedSchema, skillFitnessSchema } from "@/shared/api/domains/agents.schemas";

const row = {
  id: "e1",
  skill_name: "skill",
  kind: "multimodel",
  ref_id: "ref",
  passed: true,
  score: -0.5,
  note: "",
  created_by: "actor",
  created_at: "2026-01-01T00:00:00Z",
};
const data = { skill: "skill", evidence: [row], passing_count: 1, required: 2 };
const state = { status: "success", fetchStatus: "idle", data } as const;
describe("스킬 근거의 확정 조회와 기존 입력 계약", () => {
  it.each([
    undefined,
    null,
    {},
    { ...data, evidence: null },
    { ...data, passing_count: undefined },
    { ...data, required: "2" },
    { ...data, evidence: [{ ...row, passed: "true" }] },
    { ...data, evidence: [{ ...row, score: Infinity }] },
    { ...data, evidence: [{ ...row, created_at: "" }] },
  ])("불완전 GET %j를 기본값으로 확정하지 않는다", (value) => {
    expect(skillFitnessSchema.safeParse(value).success).toBe(false);
    expect(confirmedFitness({ ...state, data: value }, "skill")).toBeUndefined();
  });
  it("201 빈 created_at은 허용하되 GET timestamp와 구분한다", () => {
    expect(skillFitnessRecordedSchema.safeParse({ ...row, created_at: "" }).success).toBe(true);
    expect(skillFitnessRecordedSchema.safeParse({ ...row, created_at: undefined }).success).toBe(false);
    expect(skillFitnessRecordedSchema.safeParse({ ...row, created_at: "invalid" }).success).toBe(false);
    expect(confirmedFitness(state, "skill")).toEqual(data);
    expect(
      confirmedFitness({ ...state, data: { ...data, evidence: [], passing_count: 0 } }, "skill"),
    ).toBeDefined();
  });
  it.each([
    { status: "pending" },
    { status: "error" },
    { fetchStatus: "fetching" },
    { fetchStatus: "paused" },
    { isInvalidated: true },
    { data: { ...data, skill: "other" } },
    { data: { ...data, evidence: [{ ...row, skill_name: "other" }] } },
    { data: { ...data, passing_count: 2 } },
  ] as const)("미확인 상태 %j는 저장 전제조건이 아니다", (change) =>
    expect(confirmedFitness({ ...state, ...change }, "skill")).toBeUndefined(),
  );
  it.each(["", " skill", "skill ", "\ufeffskill", "skill\ufeff", "\u0085skill", "skill\u0085"])(
    "모호한 대상 %j를 정규화해 사용하지 않는다",
    (name) => {
      expect(exactFitnessSkillName(name)).toBe(false);
      expect(() => fitnessBody(name, { ...emptyFitnessForm, ref_id: "ref" })).toThrow();
    },
  );
  it.each(["skill", "한글 / + ? & #", "내부\ufeff\u0085문자"])("정확한 내부 문자 %j는 보존한다", (name) => {
    expect(exactFitnessSkillName(name)).toBe(true);
    expect(fitnessBody(name, { ...emptyFitnessForm, ref_id: " ref " }).skill).toBe(name);
  });
  it.each([
    ["", 0],
    ["   ", 0],
    ["0", 0],
    ["-1.25", -1.25],
    ["0.000000000125", 0.000000000125],
  ] as const)("점수 %j를 기존 숫자 %s로 명시 전송한다", (score, expected) => {
    const body = fitnessBody("skill", { ...emptyFitnessForm, ref_id: " ref ", note: " 메모 ", score });
    expect(body).toEqual({
      skill: "skill",
      kind: "multimodel",
      ref_id: " ref ",
      passed: true,
      score: expected,
      note: "메모",
    });
    expect(Object.isFrozen(body)).toBe(true);
  });
  it.each(["NaN", "Infinity", "1e309", "틀린 점수"])("유한하지 않은 점수 %s는 거절한다", (score) =>
    expect(fitnessFormSchema.safeParse({ ...emptyFitnessForm, ref_id: "ref", score }).success).toBe(false),
  );
  it.each(["", " \n\t", "\u0085", " \u0085\u2000 "])(
    "Go 공백으로만 구성된 참조 %j는 전송하지 않는다",
    (ref_id) => {
      expect(fitnessFormSchema.safeParse({ ...emptyFitnessForm, ref_id }).success).toBe(false);
    },
  );
  it.each(["\ufeff", "\ufeff참조", "한글\u0085내부", " ref "])(
    "유효한 참조 %j의 원래 문자열은 변환하지 않는다",
    (ref_id) => {
      expect(fitnessBody("skill", { ...emptyFitnessForm, ref_id }).ref_id).toBe(ref_id);
    },
  );
  it.each(["__proto__", "constructor", "toString"])(
    "상속 프로퍼티 %s도 알 수 없는 종류 문자열로 안전하게 표시한다",
    (kind) => {
      expect(fitnessKindLabel(kind)).toBe(`기타 근거 (${kind})`);
    },
  );
  it("알려진 종류는 한글, 미지정 종류는 정확한 식별자로 표시한다", () => {
    expect(fitnessKindLabel("multimodel")).toBe("여러 모델 비교");
    expect(fitnessKindLabel("golden")).toBe("기준 답안 세트");
    expect(fitnessKindLabel("testcase")).toBe("테스트 사례");
    expect(fitnessKindLabel("extension-kind")).toBe("기타 근거 (extension-kind)");
  });
});
