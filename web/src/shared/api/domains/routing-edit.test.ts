import { describe, expect, it } from "vitest";

import { endpoints } from "@/shared/api/endpoints";
import {
  routingEditEndpoints,
  routingEditListSchema,
  routingEditRuleSchema,
  routingEditWriteSchema,
} from "./routing-edit";

const rule = {
  id: "rule-review",
  enabled: false,
  priority: 100,
  match_pattern: "*",
  min_complexity: 0,
  max_complexity: 100,
  target_model: "model-a",
  target_provider: "",
  note: "",
  created_at: "2026-10-01T12:00:00.123456789Z",
};

describe("라우팅 수정의 원시 조회·저장 계약", () => {
  it("동일한 기존 API를 별도 엄격한 편집 계약으로 등록한다", () => {
    expect(endpoints.domains.routingEdit).toBe(routingEditEndpoints);
    expect(routingEditEndpoints.list.path).toBe(endpoints.domains.routing.rules.list.path);
    expect(routingEditEndpoints.update.path).toBe(endpoints.domains.routing.rules.update.path);
    expect(routingEditEndpoints.update.method).toBe("PATCH");
  });

  it("실제 빈 목록과 false·0·빈 문자열·원래 나노초 시각을 보존한다", () => {
    expect(routingEditListSchema.parse({ rules: [] })).toEqual({ rules: [] });
    expect(routingEditListSchema.parse({ rules: [rule] })).toEqual({ rules: [rule] });
    expect(routingEditWriteSchema.parse({ rule })).toEqual({ rule });
  });

  it.each(Object.keys(rule))("원시 %s 필드를 생략하거나 null로 대체하면 거부한다", (field) => {
    const missing = Object.fromEntries(Object.entries(rule).filter(([key]) => key !== field));
    for (const row of [missing, { ...rule, [field]: null }]) {
      expect(routingEditListSchema.safeParse({ rules: [row] }).success).toBe(false);
      expect(routingEditWriteSchema.safeParse({ rule: row }).success).toBe(false);
    }
  });

  it.each([
    { enabled: "false" },
    { enabled: 0 },
    { priority: "100" },
    { priority: 0.5 },
    { priority: Number.MAX_SAFE_INTEGER + 1 },
    { min_complexity: "0" },
    { max_complexity: null },
    { match_pattern: 1 },
    { target_model: false },
    { target_provider: [] },
    { note: {} },
    { created_at: "not-a-timestamp" },
  ])("입력 타입을 강제 변환하지 않는다: %j", (replacement) => {
    expect(routingEditRuleSchema.safeParse({ ...rule, ...replacement }).success).toBe(false);
  });

  it.each([{}, { rules: null }, { rules: {} }, null])(
    "미확인 목록을 빈 결과로 바꾸지 않는다: %j",
    (value) => {
      expect(routingEditListSchema.safeParse(value).success).toBe(false);
    },
  );

  it.each([{}, { rule: null }, { rule: [] }, { rule: {} }, null])(
    "미확인 저장 응답을 성공으로 바꾸지 않는다: %j",
    (value) => {
      expect(routingEditWriteSchema.safeParse(value).success).toBe(false);
    },
  );

  it("미래 추가 필드는 버리되 알려진 필드의 존재와 원래 값을 확인한다", () => {
    expect(routingEditWriteSchema.parse({ rule: { ...rule, future: "extra" }, future: true })).toEqual({
      rule,
    });
    // The legacy adapter intentionally remains compatible for unrelated users.
    expect(endpoints.domains.routing.rules.update.schema.safeParse({}).success).toBe(true);
  });

  it("기존 저장값의 업무 유효성을 원시 DTO 타입 검사와 혼동하지 않는다", () => {
    expect(
      routingEditRuleSchema.parse({ ...rule, priority: -1, min_complexity: 50, max_complexity: 10 }),
    ).toEqual({
      ...rule,
      priority: -1,
      min_complexity: 50,
      max_complexity: 10,
    });
    expect(routingEditRuleSchema.parse({ ...rule, created_at: "0001-01-01T00:00:00Z" }).created_at).toBe(
      "0001-01-01T00:00:00Z",
    );
  });
});
