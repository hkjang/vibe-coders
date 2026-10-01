import { describe, expect, it } from "vitest";
import type { RoutingRule } from "@/shared/api/domains/routing";
import {
  buildRuleCreate,
  createAcknowledged,
  createFields,
  createText,
  initialCreateDraft,
  protectedCreateText,
  RuleCreateProblem,
  type CreateDraft,
} from "./routing-rule-create-state";

const draft: CreateDraft = { ...initialCreateDraft, target_model: "model-a" };
const body = buildRuleCreate(draft, []);
const acknowledged: RoutingRule = {
  ...body,
  id: "route_fallback",
  created_at: "0001-01-01T00:00:00Z",
};

describe("새 라우팅 규칙의 고정 입력과 생성 응답", () => {
  it("7개 기본 입력과 enabled true만 만들며 입력 객체는 변경하지 않는다", () => {
    expect(body).toEqual({
      match_pattern: "*",
      target_model: "model-a",
      target_provider: "",
      min_complexity: 0,
      max_complexity: 100,
      priority: 100,
      enabled: true,
      note: "",
    });
    expect(Object.keys(body)).toHaveLength(8);
    expect(draft).toEqual({ ...initialCreateDraft, target_model: "model-a" });
    expect(initialCreateDraft.target_model).toBe("");
    expect(Object.isFrozen(initialCreateDraft)).toBe(true);
  });

  it("기존 JS trim을 먼저 적용하고 서버가 제거하는 NEL을 검토값에도 반영한다", () => {
    expect(
      buildRuleCreate({ ...draft, target_model: "\ufeff model-a \ufeff", note: "\u0085메모\u0085" }, []),
    ).toMatchObject({ target_model: "model-a", note: "메모" });
    // JS trim does not pass the outer NEL. Go whitespace removal then reveals
    // FEFF, which Go itself preserves. Do not apply JS trim a second time.
    expect(buildRuleCreate({ ...draft, note: "\u0085\ufeff메모\ufeff\u0085" }, []).note).toBe(
      "\ufeff메모\ufeff",
    );
    expect(buildRuleCreate({ ...draft, match_pattern: "\u0085 \u0085" }, []).match_pattern).toBe("*");
  });

  it.each(["", " ", "\u0085\u0085"])("빈 대상 모델 %j는 필드 오류다", (target_model) => {
    expect(() => buildRuleCreate({ ...draft, target_model }, [])).toThrow(RuleCreateProblem);
  });

  it.each(["", " ", "0", "-1", "1.5", "10001", "Infinity", "9007199254740992"])(
    "잘못된 우선순위 %j를 전송하지 않는다",
    (priority) => {
      try {
        buildRuleCreate({ ...draft, priority }, []);
        expect.unreachable("잘못된 우선순위를 허용했습니다.");
      } catch (cause) {
        expect(cause).toBeInstanceOf(RuleCreateProblem);
        expect(cause).toMatchObject({ field: "priority" });
      }
    },
  );

  it.each([
    { min_complexity: "" },
    { max_complexity: " " },
    { min_complexity: "-1" },
    { max_complexity: "101" },
    { min_complexity: "90", max_complexity: "80" },
  ])("잘못된 복잡도 범위 %j를 거부한다", (values) => {
    expect(() => buildRuleCreate({ ...draft, ...values }, [])).toThrow(RuleCreateProblem);
  });

  it("양쪽 경계와 우선순위 정상값은 숫자로 보내며 범위를 임의 보정하지 않는다", () => {
    expect(
      buildRuleCreate({ ...draft, min_complexity: "90", max_complexity: "100", priority: "010" }, []),
    ).toMatchObject({ min_complexity: 90, max_complexity: 100, priority: 10 });
    expect(
      buildRuleCreate({ ...draft, min_complexity: "0", max_complexity: "0", priority: "10000" }, []),
    ).toMatchObject({ min_complexity: 0, max_complexity: 0, priority: 10000 });
  });

  it.each([
    ["match_pattern", 200],
    ["target_provider", 120],
    ["note", 500],
  ] as const)("%s의 기존 %i자 경계를 유지한다", (field, limit) => {
    expect(buildRuleCreate({ ...draft, [field]: "한".repeat(limit) }, [])[field]).toHaveLength(limit);
    expect(() => buildRuleCreate({ ...draft, [field]: "한".repeat(limit + 1) }, [])).toThrow(
      RuleCreateProblem,
    );
  });

  it.each(["match_pattern", "target_model", "target_provider", "note"] as const)(
    "%s의 현재 접두사 민감값은 숨기고 전송을 거부하되 지운 뒤 정상 입력은 허용한다",
    (field) => {
      const secret = `tenant_local_${"x".repeat(40)}`;
      const next = { ...draft, [field]: secret };
      expect(buildRuleCreate(next, [])[field]).toBe(secret);
      expect(createText(secret, ["tenant_local_"])).toBe(protectedCreateText);
      expect(() => buildRuleCreate(next, ["tenant_local_"])).toThrow(RuleCreateProblem);
      const safe = field === "target_model" ? "public-model" : "";
      expect(buildRuleCreate({ ...next, [field]: safe }, ["tenant_local_"])[field]).toBe(
        field === "match_pattern" ? "*" : safe,
      );
    },
  );

  it("zero ACK 시각과 fallback ID는 허용하며 저장 후 조회 시각과 같다고 요구하지 않는다", () => {
    expect(createAcknowledged(acknowledged, body)).toBe(true);
    expect(createAcknowledged({ ...acknowledged, created_at: "2026-10-01T00:00:00.123456789Z" }, body)).toBe(
      true,
    );
    expect(createAcknowledged({ ...acknowledged, id: "" }, body)).toBe(false);
    expect(createAcknowledged({ ...acknowledged, id: " " }, body)).toBe(false);
    expect(createAcknowledged({ ...acknowledged, enabled: false }, body)).toBe(false);
  });

  it.each(createFields)("ACK의 %s 값이 검토 본문과 다르면 생성 확정으로 처리하지 않는다", (field) => {
    const previous = acknowledged[field];
    const changed = typeof previous === "number" ? previous + 1 : `${previous}-different`;
    expect(createAcknowledged({ ...acknowledged, [field]: changed }, body)).toBe(false);
  });
});
