import { describe, expect, it } from "vitest";
import { timeseriesQuerySchema } from "@/shared/api/schemas";
import { sanitizeAppRouteSearch } from "@/shared/security/app-route-query";
import { trendBucket, trendCost, trendSince } from "./overview-trend";

describe("운영 추이의 시간과 비용", () => {
  it("1시간 조회를 실제 시간 집계와 주소에 유지한다", () => {
    expect(timeseriesQuerySchema.parse({ window: "1h", bucket: "hour" })).toEqual({
      window: "1h",
      bucket: "hour",
    });
    expect(sanitizeAppRouteSearch("/overview", "?tab=usage&trend=1h").search).toBe("?tab=usage&trend=1h");
    expect(sanitizeAppRouteSearch("/overview", "?trend=1h&trend=7d").search).toBe("");
  });
  it("이미 한국 시간인 구간을 이중 변환하지 않고 CSV에는 UTC를 제공한다", () => {
    expect(trendBucket({ date: "2026-11-17T02", bucket: "hour" })).toEqual({
      label: "2026-11-17 02시",
      iso: "2026-11-16T17:00:00.000Z",
    });
    expect(trendBucket({ date: "2026-11-17", bucket: "day" })).toEqual({
      label: "2026-11-17",
      iso: "2026-11-16T15:00:00.000Z",
    });
  });
  it.each(["2026-02-30T12", "2026-11-17T24", "2026-13-17T02", "=private_value", "<img src=x>"])(
    "잘못된 구간을 원문으로 표시하거나 내보내지 않는다: %s",
    (date) => {
      expect(trendBucket({ date, bucket: "hour" })).toEqual({ label: "구간 확인 불가", iso: "" });
    },
  );
  it("작은 비용을 0원으로 반올림하지 않는다", () => {
    expect(trendCost(0)).toBe("₩0");
    expect(trendCost(0.0004)).toBe("₩0.0004");
    expect(trendCost(0.00000004)).toBe("₩4.0000e-8");
    expect(trendCost(1234.56789)).toBe("₩1,234.56789");
  });
  it("조회 시작은 명시적인 시간대가 있는 시각만 사용한다", () => {
    expect(trendSince("2026-11-17T02:15:00+09:00")).toBe("2026-11-16T17:15:00.000Z");
    expect(trendSince("2026-11-17 02:15:00")).toBeUndefined();
    expect(trendSince("private_value")).toBeUndefined();
  });
});
