import type { RoutingCreateInput } from "@/shared/api/domains/routing-create";
import type {
  RoutingLearningRecommendation,
  RoutingLearningReport,
} from "@/shared/api/domains/routing-learning";
import { containsPotentialSecret } from "@/shared/security/secrets";

export const learningWindows = ["24h", "7d", "30d", "90d"] as const;
export type LearningWindow = (typeof learningWindows)[number];
export const learningWindowLabels: Record<LearningWindow, string> = {
  "24h": "최근 24시간",
  "7d": "최근 7일",
  "30d": "최근 30일",
  "90d": "최근 90일",
};
const buckets = {
  low: { label: "낮음", min: 0, max: 33 },
  medium: { label: "보통", min: 34, max: 66 },
  high: { label: "높음", min: 67, max: 100 },
} as const;
export const recommendationChanged =
  "검토한 추천의 조회 또는 권한 기준이 바뀌었습니다. 현재 추천을 확인하고 생성 내용을 다시 검토하세요.";
export const recommendationReplaced =
  "원래 추천이나 집계 기준이 변경되었습니다. 창을 닫고 최신 추천에서 다시 선택하세요.";
export const recommendationProtected = "민감정보가 포함될 수 있어 표시하지 않습니다.";
export const recommendationFields = [
  ["match_pattern", "모델 패턴"],
  ["target_model", "대상 모델"],
  ["target_provider", "대상 공급자"],
  ["min_complexity", "최소 복잡도"],
  ["max_complexity", "최대 복잡도"],
  ["priority", "우선순위"],
  ["note", "메모"],
] as const;
export interface RecommendationSource {
  readonly window: LearningWindow;
  readonly since: string;
  readonly minSamples: number;
  readonly recommendation: Readonly<RoutingLearningRecommendation>;
}
export function learningText(value: string | number, prefixes: readonly string[], empty = "없음") {
  const text = String(value);
  return containsPotentialSecret(text, prefixes) ? recommendationProtected : text || empty;
}
export function learningBucket(bucket: string) {
  return Object.hasOwn(buckets, bucket) ? buckets[bucket as keyof typeof buckets] : undefined;
}
export function learningBucketLabel(bucket: string, prefixes: readonly string[]) {
  const known = learningBucket(bucket);
  return known
    ? `${known.label} (${known.min}–${known.max})`
    : `알 수 없음 (${learningText(bucket, prefixes)})`;
}
export function recommendationSource(
  window: LearningWindow,
  report: RoutingLearningReport,
  recommendation: RoutingLearningRecommendation,
): RecommendationSource {
  return Object.freeze({
    window,
    since: report.since,
    minSamples: report.min_samples,
    recommendation: Object.freeze({ ...recommendation }),
  });
}
export function sameRecommendation(a: RoutingLearningRecommendation, b: RoutingLearningRecommendation) {
  return (Object.keys(a) as Array<keyof RoutingLearningRecommendation>).every((key) => a[key] === b[key]);
}
export function currentRecommendation(source: RecommendationSource, report: RoutingLearningReport) {
  if (source.since !== report.since || source.minSamples !== report.min_samples) return undefined;
  const matches = report.recommendations.filter((item) => sameRecommendation(item, source.recommendation));
  return matches.length === 1 ? matches[0] : undefined;
}
export function buildRecommendation(
  recommendation: RoutingLearningRecommendation,
  prefixes: readonly string[],
): Readonly<RoutingCreateInput> {
  const range = learningBucket(recommendation.bucket);
  if (!range) throw new Error("알 수 없는 복잡도 구간으로는 규칙을 만들 수 없습니다.");
  if (!recommendation.differs) throw new Error("관측 최다 모델과 동일한 추천입니다.");
  // This path previously sent server-provided strings without JS trim. Match
  // Go TrimSpace only: NEL is whitespace; FEFF is deliberately preserved.
  const trim = (value: string) => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  const body: RoutingCreateInput = {
    match_pattern: "*",
    target_model: trim(recommendation.recommended_model),
    target_provider: "",
    min_complexity: range.min,
    max_complexity: range.max,
    priority: 100,
    enabled: true,
    note: trim(`학습 추천 적용 (${recommendation.task_type}/${recommendation.bucket})`),
  };
  if (!body.target_model) throw new Error("추천 대상 모델을 확인할 수 없습니다.");
  if (recommendationFields.some(([field]) => containsPotentialSecret(String(body[field]), prefixes)))
    throw new Error("민감정보로 보이는 추천값이 있어 규칙을 만들 수 없습니다.");
  return Object.freeze(body);
}
export function recommendationProblem(item: RoutingLearningRecommendation, prefixes: readonly string[]) {
  try {
    buildRecommendation(item, prefixes);
    return undefined;
  } catch (cause) {
    return cause instanceof Error ? cause.message : "추천을 확인할 수 없습니다.";
  }
}
