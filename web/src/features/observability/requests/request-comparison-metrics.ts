import type { AppRequestSummary } from "@/shared/api/schemas";
import { containsPotentialSecret } from "@/shared/security/secrets";
import {
  formatRequestMetric,
  requestCostText,
  visibleRequestCurrency,
  unavailableRequestMetricLabels,
} from "./request-metric-format";

export interface ComparisonMetric {
  label: string;
  left: string;
  right: string;
  leftExact?: string;
  rightExact?: string;
  change: string;
  state: "same" | "different" | "unavailable";
}

function difference(left: number, right: number, unit: string): Pick<ComparisonMetric, "change" | "state"> {
  if (!Number.isFinite(left) || !Number.isFinite(right))
    return { change: "기록 확인 필요", state: "unavailable" };
  if (left === right) return { change: "같음", state: "same" };
  return {
    change: `${formatRequestMetric(Math.abs(right - left))} ${unit} ${right > left ? "증가" : "감소"}`,
    state: "different",
  };
}

function textMetric(
  label: string,
  left: string,
  right: string,
  prefixes: readonly string[],
): ComparisonMetric {
  const publicText = (value: string) =>
    value !== "" && !unavailableRequestMetricLabels.has(value) && !containsPotentialSecret(value, prefixes);
  const visible = (value: string) =>
    containsPotentialSecret(value, prefixes) ? "[값 비공개]" : value || "미기록";
  const available = publicText(left) && publicText(right);
  return {
    label,
    left: visible(left),
    right: visible(right),
    change: available ? (left === right ? "같음" : "다름") : "비공개·생략·미기록 값은 비교 제외",
    state: available ? (left === right ? "same" : "different") : "unavailable",
  };
}

export function requestComparisonMetrics(
  left: AppRequestSummary,
  right: AppRequestSummary,
  prefixes: readonly string[],
): ComparisonMetric[] {
  const metric = (label: string, a: number, b: number, unit: string): ComparisonMetric => ({
    label,
    left: `${formatRequestMetric(a)} ${unit}`,
    right: `${formatRequestMetric(b)} ${unit}`,
    ...difference(a, b, unit),
  });
  const a = visibleRequestCurrency(left.currency, prefixes),
    b = visibleRequestCurrency(right.currency, prefixes);
  const cost: ComparisonMetric = {
    label: "추정 비용",
    left: requestCostText(left.estimated_cost, left.currency, prefixes),
    right: requestCostText(right.estimated_cost, right.currency, prefixes),
    leftExact: `${String(left.estimated_cost)} ${a ?? "(통화 미확인)"}`,
    rightExact: `${String(right.estimated_cost)} ${b ?? "(통화 미확인)"}`,
    ...(a && b && a === b
      ? difference(left.estimated_cost, right.estimated_cost, a)
      : {
          change: !a || !b ? "통화 미확인 · 비교 제외" : "통화가 달라 비교 제외",
          state: "unavailable" as const,
        }),
  };
  const firstChunk = metric("첫 청크 지연", left.first_chunk_ms, right.first_chunk_ms, "ms");
  if (!left.stream || !right.stream) {
    if (!left.stream) firstChunk.left = "비스트리밍 요청";
    if (!right.stream) firstChunk.right = "비스트리밍 요청";
    firstChunk.change = "스트리밍 요청끼리 비교 가능";
    firstChunk.state = "unavailable";
  }
  return [
    textMetric("요청 ID", left.request_id, right.request_id, prefixes),
    textMetric("모델", left.model, right.model, prefixes),
    textMetric("공급자", left.provider_display, right.provider_display, prefixes),
    textMetric(
      "응답 상태",
      left.status_code ? `HTTP ${left.status_code}` : "",
      right.status_code ? `HTTP ${right.status_code}` : "",
      prefixes,
    ),
    metric("전체 지연", left.latency_ms, right.latency_ms, "ms"),
    firstChunk,
    metric("입력 토큰", left.prompt_tokens, right.prompt_tokens, "토큰"),
    metric("출력 토큰", left.completion_tokens, right.completion_tokens, "토큰"),
    metric("전체 토큰", left.total_tokens, right.total_tokens, "토큰"),
    metric("캐시 토큰", left.cached_tokens, right.cached_tokens, "토큰"),
    metric("추론 토큰", left.reasoning_tokens, right.reasoning_tokens, "토큰"),
    cost,
  ];
}
