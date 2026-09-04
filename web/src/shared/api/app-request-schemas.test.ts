import { describe, expect, it } from "vitest";

import {
  appRequestSummarySchema,
  appRequestsQuerySchema,
  appRequestsResponseSchema,
} from "@/shared/api/schemas";

const providerRef = `prv_${"a".repeat(43)}`;
const requestRef = `req_${"r".repeat(22)}.${"r".repeat(21)}`;
const timestamp = "2026-09-03T01:02:03.000000000Z";

const validSummary = {
  api_key_id: "key-test",
  cached_tokens: 2,
  completion_tokens: 3,
  created_at: timestamp,
  currency: "KRW",
  endpoint: "/v1/chat/completions",
  estimated_cost: 1.25,
  finish_reason: "stop",
  first_chunk_ms: 50,
  ip: "192.0.2.10",
  latency_ms: 100,
  method: "POST",
  model: "gpt-test",
  prompt_tokens: 4,
  provider_display: "테스트 공급자",
  provider_ref: providerRef,
  reasoning_tokens: 1,
  request_filterable: true,
  request_id: "req-test",
  request_ref: requestRef,
  session_id: "session-test",
  status_code: 200,
  stream: false,
  total_tokens: 7,
  trace_filterable: true,
  trace_id: "trace-test",
} as const;

const validResponse = {
  generated_at: timestamp,
  limit: 200,
  next_cursor: "n".repeat(4096),
  previous_cursor: "p".repeat(4096),
  requests: [validSummary],
} as const;

function withoutV2Identity(summary: typeof validSummary): Record<string, unknown> {
  const legacy: Record<string, unknown> = { ...summary };
  delete legacy.request_ref;
  delete legacy.request_filterable;
  delete legacy.trace_filterable;
  return legacy;
}

describe("요청 탐색기 API 런타임 스키마", () => {
  it("서버가 보장하는 문자열과 숫자 최댓값을 허용한다", () => {
    expect(
      appRequestSummarySchema.safeParse({
        ...validSummary,
        api_key_id: "a".repeat(512),
        cached_tokens: 2_147_483_647,
        completion_tokens: 2_147_483_647,
        currency: "c".repeat(16),
        endpoint: "e".repeat(512),
        estimated_cost: 1_000_000_000_000_000,
        finish_reason: "f".repeat(256),
        first_chunk_ms: Number.MAX_SAFE_INTEGER,
        ip: "i".repeat(128),
        latency_ms: Number.MAX_SAFE_INTEGER,
        method: "m".repeat(32),
        model: "m".repeat(256),
        prompt_tokens: 2_147_483_647,
        provider_display: "p".repeat(256),
        reasoning_tokens: 2_147_483_647,
        request_id: "r".repeat(512),
        session_id: "s".repeat(512),
        status_code: 999,
        total_tokens: 2_147_483_647,
        trace_id: "t".repeat(512),
      }).success,
    ).toBe(true);
    expect(appRequestsResponseSchema.parse(validResponse).request_contract_version).toBe(2);
    expect(
      appRequestsResponseSchema.safeParse({
        ...validResponse,
        limit: 1,
        requests: [
          {
            ...validSummary,
            cached_tokens: 0,
            completion_tokens: 0,
            estimated_cost: 0,
            first_chunk_ms: 0,
            latency_ms: 0,
            prompt_tokens: 0,
            reasoning_tokens: 0,
            status_code: 0,
            total_tokens: 0,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("롤링 배포의 v0.82 안전 응답을 보수적인 읽기 전용 행으로 변환한다", () => {
    const parsed = appRequestsResponseSchema.parse({
      ...validResponse,
      requests: [withoutV2Identity(validSummary), withoutV2Identity(validSummary)],
    });

    expect(parsed.request_contract_version).toBe(1);
    expect(parsed.requests).toHaveLength(2);
    expect(parsed.requests[0]).toMatchObject({
      request_filterable: false,
      trace_filterable: false,
    });
    expect(parsed.requests[0]?.request_ref).toMatch(/^req_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{21}$/u);
    expect(parsed.requests[1]?.request_ref).not.toBe(parsed.requests[0]?.request_ref);
  });

  it("문자 수가 아니라 UTF-8 바이트 수로 문자열 경계를 검사한다", () => {
    expect(
      appRequestSummarySchema.safeParse({
        ...validSummary,
        request_id: `${"가".repeat(170)}aa`,
      }).success,
    ).toBe(true);
    expect(
      appRequestSummarySchema.safeParse({
        ...validSummary,
        request_id: "가".repeat(171),
      }).success,
    ).toBe(false);
    expect(appRequestsQuerySchema.safeParse({ trace_id: `${"가".repeat(170)}aa` }).success).toBe(true);
    expect(appRequestsQuerySchema.safeParse({ trace_id: "가".repeat(171) }).success).toBe(false);
  });

  it.each([
    ["request_id", "r".repeat(513)],
    ["trace_id", "t".repeat(513)],
    ["session_id", "s".repeat(513)],
    ["api_key_id", "a".repeat(513)],
    ["ip", "i".repeat(129)],
    ["method", "m".repeat(33)],
    ["model", "m".repeat(257)],
    ["provider_display", "p".repeat(257)],
    ["endpoint", "e".repeat(513)],
    ["currency", "c".repeat(17)],
    ["finish_reason", "f".repeat(257)],
  ] as const)("%s 문자열 경계 초과를 거부한다", (field, value) => {
    expect(appRequestSummarySchema.safeParse({ ...validSummary, [field]: value }).success).toBe(false);
  });

  it.each([
    ["status_code", -1],
    ["status_code", 1_000],
    ["latency_ms", -1],
    ["latency_ms", Number.MAX_SAFE_INTEGER + 1],
    ["first_chunk_ms", -1],
    ["first_chunk_ms", Number.MAX_SAFE_INTEGER + 1],
    ["prompt_tokens", -1],
    ["prompt_tokens", 2_147_483_648],
    ["completion_tokens", 1.5],
    ["total_tokens", 2_147_483_648],
    ["cached_tokens", 2_147_483_648],
    ["reasoning_tokens", 2_147_483_648],
    ["estimated_cost", -1],
    ["estimated_cost", 1_000_000_000_000_001],
  ] as const)("%s 숫자 경계 위반을 거부한다", (field, value) => {
    expect(appRequestSummarySchema.safeParse({ ...validSummary, [field]: value }).success).toBe(false);
  });

  it.each(["status_code", "latency_ms", "first_chunk_ms", "prompt_tokens", "estimated_cost"] as const)(
    "%s의 NaN과 무한대를 거부한다",
    (field) => {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(appRequestSummarySchema.safeParse({ ...validSummary, [field]: value }).success).toBe(false);
      }
    },
  );

  it("응답 행 수, 커서, limit 경계를 엄격히 검사한다", () => {
    expect(
      appRequestsResponseSchema.safeParse({
        ...validResponse,
        requests: Array.from({ length: 200 }, () => validSummary),
      }).success,
    ).toBe(true);
    expect(
      appRequestsResponseSchema.safeParse({
        ...validResponse,
        requests: Array.from({ length: 201 }, () => validSummary),
      }).success,
    ).toBe(false);
    expect(
      appRequestsResponseSchema.safeParse({ ...validResponse, next_cursor: "n".repeat(4097) }).success,
    ).toBe(false);
    expect(
      appRequestsResponseSchema.safeParse({ ...validResponse, next_cursor: "가".repeat(1_366) }).success,
    ).toBe(false);
    expect(appRequestsResponseSchema.safeParse({ ...validResponse, previous_cursor: "" }).success).toBe(
      false,
    );
    expect(appRequestsResponseSchema.safeParse({ ...validResponse, limit: 0 }).success).toBe(false);
    expect(appRequestsResponseSchema.safeParse({ ...validResponse, limit: 201 }).success).toBe(false);
    expect(
      appRequestSummarySchema.safeParse({ ...validSummary, provider_ref: `${providerRef}x` }).success,
    ).toBe(false);
    expect(
      appRequestSummarySchema.safeParse({ ...validSummary, request_ref: `${requestRef}x` }).success,
    ).toBe(false);
    expect(appRequestSummarySchema.safeParse({ ...validSummary, request_filterable: "true" }).success).toBe(
      false,
    );
    expect(appRequestSummarySchema.safeParse({ ...validSummary, trace_filterable: 1 }).success).toBe(false);
  });

  it.each(["created_at", "generated_at"] as const)("%s가 올바른 제한 내 날짜·시각이어야 한다", (field) => {
    const target =
      field === "created_at"
        ? { ...validResponse, requests: [{ ...validSummary, created_at: "not-a-timestamp" }] }
        : { ...validResponse, generated_at: "not-a-timestamp" };
    expect(appRequestsResponseSchema.safeParse(target).success).toBe(false);

    const overlong = "2026-09-03T01:02:03.000000000+09:00";
    const overlongTarget =
      field === "created_at"
        ? { ...validResponse, requests: [{ ...validSummary, created_at: overlong }] }
        : { ...validResponse, generated_at: overlong };
    expect(appRequestsResponseSchema.safeParse(overlongTarget).success).toBe(false);
  });
});
