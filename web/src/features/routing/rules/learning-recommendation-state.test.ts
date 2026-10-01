import { describe, expect, it } from "vitest";
import type {
  RoutingLearningRecommendation,
  RoutingLearningReport,
} from "@/shared/api/domains/routing-learning";
import {
  buildRecommendation,
  currentRecommendation,
  learningBucketLabel,
  learningText,
  recommendationProblem,
  recommendationProtected,
  recommendationSource,
  sameRecommendation,
} from "./learning-recommendation-state";

const recommendation: RoutingLearningRecommendation = {
  task_type: "coding",
  bucket: "low",
  recommended_model: "model-next",
  success_rate: 0.98,
  avg_cost_krw: 3.5,
  samples: 80,
  top_model: "model-observed",
  top_success_rate: 0.9,
  differs: true,
  confident: true,
  rationale: "성공률과 비용 비교",
};
const report: RoutingLearningReport = {
  since: "2026-10-01T01:00:00Z",
  min_samples: 20,
  cells: [],
  recommendations: [recommendation],
};

describe("학습 추천의 실제 생성 범위와 고정 원본", () => {
  it.each([
    ["low", 0, 33],
    ["medium", 34, 66],
    ["high", 67, 100],
  ] as const)("%s 구간은 서버 집계 경계 %i–%i와 같다", (bucket, min_complexity, max_complexity) => {
    const input = { ...recommendation, bucket };
    expect(buildRecommendation(input, [])).toEqual({
      match_pattern: "*",
      target_model: "model-next",
      target_provider: "",
      min_complexity,
      max_complexity,
      priority: 100,
      enabled: true,
      note: `학습 추천 적용 (coding/${bucket})`,
    });
    expect(Object.keys(buildRecommendation(input, []))).toHaveLength(8);
    expect(Object.isFrozen(buildRecommendation(input, []))).toBe(true);
    expect(input).toEqual({ ...recommendation, bucket });
  });
  it.each(["", "LOW", "unknown", "__proto__", "constructor", " high "])(
    "지원하지 않는 %j 구간을 전체 복잡도로 확대하지 않는다",
    (bucket) => {
      expect(() => buildRecommendation({ ...recommendation, bucket }, [])).toThrow("알 수 없는 복잡도 구간");
      expect(recommendationProblem({ ...recommendation, bucket }, [])).toContain("알 수 없는 복잡도 구간");
    },
  );
  it.each([
    ["\u0085 model-next \u0085", "model-next"],
    ["\ufeffmodel-next\ufeff", "\ufeffmodel-next\ufeff"],
    ["\u0085\ufeffmodel-next\ufeff\u0085", "\ufeffmodel-next\ufeff"],
    ["\ufeff\u0085model-next\u0085\ufeff", "\ufeff\u0085model-next\u0085\ufeff"],
  ])("모델 %j에는 JS trim 없이 Go 공백 처리만 한다", (raw, expected) => {
    expect(buildRecommendation({ ...recommendation, recommended_model: raw }, []).target_model).toBe(
      expected,
    );
  });
  it.each(["", " \n", "\u0085\u2000"])("빈 모델 %j는 생성하지 않는다", (recommended_model) => {
    expect(() => buildRecommendation({ ...recommendation, recommended_model }, [])).toThrow("대상 모델");
  });
  it("작업 유형은 메모에만 포함하고 실제 조건 필드를 추가하지 않는다", () => {
    const result = buildRecommendation({ ...recommendation, task_type: "\ufeff coding \u0085" }, []);
    expect(result.match_pattern).toBe("*");
    expect(result.note).toBe("학습 추천 적용 (\ufeff coding \u0085/low)");
    expect(result).not.toHaveProperty("task_type");
  });
  it("같은 관측 최다 모델이라는 값은 활성 규칙 존재가 아니라 추천 비교 결과로만 처리한다", () => {
    expect(() => buildRecommendation({ ...recommendation, differs: false }, [])).toThrow(
      "관측 최다 모델과 동일",
    );
    expect(buildRecommendation({ ...recommendation, confident: false }, []).target_model).toBe("model-next");
  });
  it.each(["recommended_model", "task_type"] as const)(
    "%s의 현재 접두사 민감값은 원문 재작성 없이 생성 차단",
    (field) => {
      const secret = `custom_${"x".repeat(40)}`;
      const input = { ...recommendation, [field]: secret };
      expect(buildRecommendation(input, [])).toBeDefined();
      expect(() => buildRecommendation(input, ["custom_"])).toThrow("민감정보");
      expect(learningText(secret, ["custom_"])).toBe(recommendationProtected);
      expect(input[field]).toBe(secret);
    },
  );
  it("표시만 보호하고 알려진 구간은 한글 경계를 제공한다", () => {
    expect(learningBucketLabel("medium", [])).toBe("보통 (34–66)");
    expect(learningBucketLabel("secret=private", [])).toBe(`알 수 없음 (${recommendationProtected})`);
    expect(learningText("", [])).toBe("없음");
  });
  it("원추천 복사는 이후 입력 객체 변경과 별개이며 서버 since와 요청 window를 구별한다", () => {
    const input = { ...recommendation };
    const source = recommendationSource("7d", report, input);
    input.recommended_model = "later";
    expect(source.recommendation.recommended_model).toBe("model-next");
    expect(source.window).toBe("7d");
    expect(source.since).toBe(report.since);
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.recommendation)).toBe(true);
  });
  it.each([
    { since: "2026-10-02T01:00:00Z" },
    { min_samples: 21 },
    { recommendations: [] },
    { recommendations: [recommendation, { ...recommendation }] },
  ])("집계기준·원추천이 없거나 모호한 현재 결과 %j에서 재승인하지 않는다", (change) => {
    expect(
      currentRecommendation(recommendationSource("7d", report, recommendation), { ...report, ...change }),
    ).toBeUndefined();
  });
  it.each(Object.keys(recommendation) as Array<keyof RoutingLearningRecommendation>)(
    "원추천의 %s 변경도 보존하지 않은 새 추천으로 구분한다",
    (field) => {
      const old = recommendation[field];
      const changed = {
        ...recommendation,
        [field]: typeof old === "boolean" ? !old : typeof old === "number" ? old + 1 : `${old}-changed`,
      };
      expect(sameRecommendation(recommendation, changed)).toBe(false);
      expect(
        currentRecommendation(recommendationSource("7d", report, recommendation), {
          ...report,
          recommendations: [changed],
        }),
      ).toBeUndefined();
    },
  );
  it("동일한 현재 추천은 명시 재검토용으로 찾을 수 있다", () => {
    const refreshed = { ...recommendation };
    expect(
      currentRecommendation(recommendationSource("7d", report, recommendation), {
        ...report,
        recommendations: [refreshed],
      }),
    ).toBe(refreshed);
  });
});
