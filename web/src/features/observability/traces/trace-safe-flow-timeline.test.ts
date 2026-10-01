import { describe, expect, it } from "vitest";
import { flowTimeline } from "./trace-safe-flow-timeline";
import type { TraceSafeFlow } from "@/shared/api/domains/trace-safe-flow.schema";
const span = (offset_ms: number | null, duration_ms: number | null): TraceSafeFlow["spans"][number] => ({
  span_ref: `span_${"a".repeat(43)}`,
  parent_ref: null,
  kind: "request",
  name: "기록",
  status: "unknown",
  recorded_at: null,
  offset_ms,
  duration_ms,
});
describe("기록 타임라인 시각 비율", () => {
  it("음수 위치와 양수 지연을 동일 축에 놓고 미기록을 0으로 바꾸지 않는다", () => {
    expect(flowTimeline([span(-50, 25), span(0, 50), span(null, null)])).toEqual([
      { left: 0, width: 25, point: false },
      { left: 50, width: 50, point: false },
      undefined,
    ]);
  });
  it("0과 미측정 길이는 점으로 보이고 안전정수 극단값도 유한한 비율이다", () => {
    const values = flowTimeline([
      span(Number.MIN_SAFE_INTEGER, null),
      span(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
      span(0, 0),
    ]);
    for (const value of values) {
      expect(Number.isFinite(value?.left)).toBe(true);
      expect(Number.isFinite(value?.width)).toBe(true);
    }
    expect(values[0]?.point).toBe(true);
    expect(values[2]?.point).toBe(true);
    expect(flowTimeline([span(0, 0)])[0]).toEqual({ left: 0, width: 0, point: true });
  });
});
