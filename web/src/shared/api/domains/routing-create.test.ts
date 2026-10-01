import { describe, expect, it } from "vitest";

import { endpoints } from "@/shared/api/endpoints";
import { routingCreateEndpoints, routingCreateRuleSchema, routingCreateWriteSchema } from "./routing-create";
import { routingEditEndpoints } from "./routing-edit";

const rule = {
  id: "route_created_public",
  enabled: true,
  priority: 100,
  match_pattern: "*",
  min_complexity: 0,
  max_complexity: 100,
  target_model: "public-model",
  target_provider: "",
  note: "",
  created_at: "0001-01-01T00:00:00Z",
};

describe("신규 라우팅 규칙의 엄격한 생성 응답 계약", () => {
  it("기존 POST 경로와 엄격한 조회 경로를 새 생성 UI에 등록한다", () => {
    expect(endpoints.domains.routingCreate).toBe(routingCreateEndpoints);
    expect(routingCreateEndpoints.create.method).toBe("POST");
    expect(routingCreateEndpoints.create.path).toBe(endpoints.domains.routing.rules.create.path);
    expect(routingCreateEndpoints.list).toBe(routingEditEndpoints.list);
  });

  it("Go zero ACK 시각과 실제 저장 시각을 변환하거나 같다고 가정하지 않는다", () => {
    expect(routingCreateWriteSchema.parse({ rule })).toEqual({ rule });
    const stored = { ...rule, created_at: "2026-10-02T01:23:45.123456789Z" };
    expect(routingCreateEndpoints.list.schema.parse({ rules: [stored] })).toEqual({ rules: [stored] });
    expect(stored.created_at).not.toBe(rule.created_at);
  });

  it.each(Object.keys(rule))("원래 %s 필드의 생략과 null을 거부한다", (field) => {
    const missing = Object.fromEntries(Object.entries(rule).filter(([key]) => key !== field));
    for (const value of [missing, { ...rule, [field]: null }])
      expect(routingCreateWriteSchema.safeParse({ rule: value }).success).toBe(false);
  });

  it.each([
    { id: "" },
    { id: "   " },
    { id: "\u0085" },
    { id: 4 },
    { enabled: "true" },
    { enabled: 1 },
    { priority: "100" },
    { priority: 1.5 },
    { priority: Number.MAX_SAFE_INTEGER + 1 },
    { min_complexity: "0" },
    { max_complexity: [] },
    { target_model: false },
    { target_provider: {} },
    { note: [] },
    { match_pattern: 1 },
    { created_at: "not-a-time" },
  ])("잘못된 필드를 기본값이나 다른 타입으로 바꾸지 않는다: %j", (replacement) => {
    expect(routingCreateRuleSchema.safeParse({ ...rule, ...replacement }).success).toBe(false);
  });

  it.each([{}, null, { rule: null }, { rule: [] }, { rule: {} }])(
    "미확인 ACK는 성공이 아니다: %j",
    (value) => {
      expect(routingCreateWriteSchema.safeParse(value).success).toBe(false);
    },
  );

  it("알려진 필드의 false·0·빈 문자열은 보존하고 미래 추가 필드만 버린다", () => {
    const other = { ...rule, enabled: false, priority: 0, max_complexity: 0 };
    expect(routingCreateWriteSchema.parse({ rule: { ...other, future: true }, future: "extra" })).toEqual({
      rule: other,
    });
    // Business equality against the reviewed body is a separate UI check.
    expect(endpoints.domains.routing.rules.create.schema.safeParse({}).success).toBe(true);
  });
});
