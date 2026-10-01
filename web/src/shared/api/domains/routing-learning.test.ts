import { describe, expect, it } from "vitest";
import { endpoints } from "../endpoints";

import {
  routingLearningEndpoints,
  routingLearningQuerySchema,
  routingLearningReportSchema,
} from "./routing-learning";

const cell = {
  task_type: "code",
  bucket: "low",
  model: "public-model",
  requests: 30,
  successes: 29,
  success_rate: 29 / 30,
  fallback_rate: 0,
  avg_cost_krw: 1.2,
  avg_latency_ms: 100,
  thumbs_up: 2,
  thumbs_down: 0,
};
const recommendation = {
  task_type: "code",
  bucket: "low",
  recommended_model: "public-model",
  success_rate: 29 / 30,
  avg_cost_krw: 1.2,
  samples: 30,
  top_model: "public-most-used",
  top_success_rate: 0.7,
  differs: true,
  confident: false,
  rationale: "공개 합성 추천 근거",
};
const report = {
  since: "2026-10-01T00:00:00Z",
  min_samples: 20,
  cells: [cell],
  recommendations: [recommendation],
};

describe("학습 추천 검토의 실제 수신 보고서 계약", () => {
  it("실제 필드를 그대로 보존하고 생성이나 모의실행이 아닌 기존 GET을 사용한다", () => {
    expect(endpoints.domains.routingLearning).toBe(routingLearningEndpoints);
    expect(routingLearningReportSchema.parse(report)).toEqual(report);
    expect(routingLearningEndpoints.report.method).toBe("GET");
    expect(routingLearningEndpoints.report.path).toBe("/admin/routing/learning");
    expect(routingLearningEndpoints.report.schema).toBe(routingLearningReportSchema);
  });
  it("추천 없음과 일부 비교 모델의 표본 미달은 정상 응답이다", () => {
    expect(routingLearningReportSchema.parse({ ...report, cells: [], recommendations: [] })).toEqual({
      ...report,
      cells: [],
      recommendations: [],
    });
    expect(routingLearningReportSchema.parse(report).recommendations[0]?.confident).toBe(false);
  });
  it("모델·작업 유형의 Go 전송 전 원문과 아직 모르는 구간은 조회에서 임의 보정하지 않는다", () => {
    const raw = {
      ...recommendation,
      bucket: "future",
      task_type: "\u0085code\ufeff",
      recommended_model: "\ufeff public-model \u0085",
    };
    expect(routingLearningReportSchema.parse({ ...report, recommendations: [raw] }).recommendations).toEqual([
      raw,
    ]);
  });
  it("알 수 없는 추가 필드는 새 보고서 캐시에 전파하지 않는다", () => {
    expect(
      routingLearningReportSchema.parse({
        ...report,
        extra: "public-extra",
        cells: [{ ...cell, extra: "public-extra" }],
        recommendations: [{ ...recommendation, extra: "public-extra" }],
      }),
    ).toEqual(report);
  });
  it.each(Object.keys(report))("보고서의 %s 누락을 기본값으로 바꾸지 않는다", (field) => {
    const missing = Object.fromEntries(Object.entries(report).filter(([key]) => key !== field));
    expect(routingLearningReportSchema.safeParse(missing).success).toBe(false);
  });
  it.each(Object.keys(recommendation))("추천의 %s 누락은 검토 가능한 응답이 아니다", (field) => {
    const missing = Object.fromEntries(Object.entries(recommendation).filter(([key]) => key !== field));
    expect(routingLearningReportSchema.safeParse({ ...report, recommendations: [missing] }).success).toBe(
      false,
    );
  });
  it.each(Object.keys(cell))("집계의 %s 누락도 조회 실패로 구분한다", (field) => {
    const missing = Object.fromEntries(Object.entries(cell).filter(([key]) => key !== field));
    expect(routingLearningReportSchema.safeParse({ ...report, cells: [missing] }).success).toBe(false);
  });
  it.each([
    { min_samples: 0 },
    { min_samples: "20" },
    { since: "invalid" },
    { cells: null },
    { recommendations: null },
    { recommendations: [{ ...recommendation, differs: "true" }] },
    { recommendations: [{ ...recommendation, confident: null }] },
    { recommendations: [{ ...recommendation, samples: -1 }] },
    { recommendations: [{ ...recommendation, samples: 1.5 }] },
    { recommendations: [{ ...recommendation, samples: Number.MAX_SAFE_INTEGER + 1 }] },
    { recommendations: [{ ...recommendation, avg_cost_krw: Infinity }] },
    { recommendations: [{ ...recommendation, success_rate: NaN }] },
    { cells: [{ ...cell, requests: "30" }] },
    { cells: [{ ...cell, avg_latency_ms: null }] },
  ])("잘못된 필드 타입이나 표현할 수 없는 값은 거부한다: %j", (patch) => {
    expect(routingLearningReportSchema.safeParse({ ...report, ...patch }).success).toBe(false);
  });
  it.each(["24h", "7d", "30d", "90d"])("화면의 조회 기간 %s를 전송한다", (window) => {
    expect(routingLearningQuerySchema.parse({ window })).toEqual({ window });
  });
  it("다른 서버 클라이언트의 임의 duration 지원을 이 화면의 기간 지원으로 오인하지 않는다", () => {
    expect(routingLearningQuerySchema.safeParse({ window: "12h" }).success).toBe(false);
  });
});
