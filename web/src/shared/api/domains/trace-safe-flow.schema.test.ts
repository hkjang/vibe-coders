import { describe, expect, it } from "vitest";
import { flowTimestampSchema, traceSafeFlowQuerySchema, traceSafeFlowSchema } from "./trace-safe-flow.schema";

const at = "2026-10-01T01:02:03.123456789Z";
const root = {
  span_ref: `span_${"a".repeat(43)}`,
  parent_ref: null,
  kind: "request",
  name: "요청 기록",
  status: "unknown",
  recorded_at: at,
  offset_ms: 0,
  duration_ms: 0,
};
const child = {
  ...root,
  span_ref: `span_${"b".repeat(43)}`,
  parent_ref: root.span_ref,
  kind: "tool",
  recorded_at: null,
  offset_ms: null,
  duration_ms: null,
};
const valid = () => ({
  flow_version: 1,
  request_ref: `req_${"a".repeat(22)}.${"b".repeat(21)}`,
  created_at: at,
  generated_at: at,
  spans: [root, child],
  coverage: {
    tools: { limit: 100, truncated: false, omitted: 0 },
    text2sql: { limit: 100, truncated: false, omitted: 0 },
  },
});
describe("안전 요청 단계 strict 계약", () => {
  it("나노초 원문과 null·기록된 0을 구분해 보존한다", () => {
    expect(traceSafeFlowSchema.parse(valid()).spans.map((row) => row.duration_ms)).toEqual([0, null]);
    expect(
      traceSafeFlowQuerySchema.parse({ request_ref: valid().request_ref, created_at: at }).created_at,
    ).toBe(at);
  });
  it.each([
    "2026-10-01T01:02:03Z",
    "2026-10-01T01:02:03.123Z",
    "2026-02-30T01:02:03.123456789Z",
    "2026-10-01T10:02:03.123456789+09:00",
  ])("비정규 날짜 %s를 변환하지 않고 거부한다", (value) => {
    expect(flowTimestampSchema.safeParse(value).success).toBe(false);
  });
  it.each([
    { extra: "raw" },
    { flow_version: 2 },
    { spans: [] },
    { spans: [child, root] },
    { spans: [root, { ...child, parent_ref: null }] },
    { spans: [root, { ...child, span_ref: root.span_ref }] },
    { spans: [root, { ...child, duration_ms: 0 }] },
    { spans: [{ ...root, duration_ms: -1 }] },
    { spans: [{ ...root, offset_ms: Number.MAX_SAFE_INTEGER + 1 }] },
    { spans: [{ ...root, status: "invented" }] },
    { spans: [{ ...root, prompt: "raw" }] },
    { spans: [{ ...root, name: "한".repeat(86) }] },
    { spans: [{ ...root, recorded_at: null }] },
    { spans: [{ ...root, recorded_at: "2026-10-01T01:02:03.123456788Z" }] },
    { spans: [{ ...root, offset_ms: 1 }] },
  ])("불명확한 구조·수치·원문 확장을 거부한다 %#", (patch) => {
    expect(traceSafeFlowSchema.safeParse({ ...valid(), ...patch }).success).toBe(false);
  });
  it("서명된 상대 위치와 잘림·생략은 별개의 값이다", () => {
    const value = {
      ...valid(),
      spans: [root, { ...child, recorded_at: at, offset_ms: -25 }],
      coverage: {
        tools: { limit: 100, truncated: true, omitted: 99 },
        text2sql: { limit: 100, truncated: false, omitted: 100 },
      },
    };
    expect(traceSafeFlowSchema.parse(value).spans[1]?.offset_ms).toBe(-25);
    expect(
      traceSafeFlowSchema.safeParse({
        ...value,
        coverage: { ...value.coverage, tools: { limit: 100, truncated: true, omitted: 100 } },
      }).success,
    ).toBe(false);
  });
  it("query에 raw ID나 알 수 없는 필드를 허용하지 않는다", () => {
    expect(
      traceSafeFlowQuerySchema.safeParse({
        request_ref: valid().request_ref,
        created_at: at,
        request_id: "raw",
      }).success,
    ).toBe(false);
  });
});
