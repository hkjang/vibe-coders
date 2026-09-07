import type { ScatterPoint } from "@/shared/api/domains/observability.schemas";

export const scatterMetrics = [
  { value: "latency", label: "응답 지연(ms)" },
  { value: "first_chunk", label: "첫 청크(ms)" },
  { value: "tokens", label: "토큰" },
  { value: "cost", label: "비용(원)" },
  { value: "risk", label: "위험 점수" },
  { value: "health", label: "건강 점수" },
] as const;
export type ScatterMetric = (typeof scatterMetrics)[number]["value"];

export const scatterViewModes = [
  { value: "category", label: "상태별" },
  { value: "model", label: "모델별" },
] as const;
export type ScatterViewMode = (typeof scatterViewModes)[number]["value"];

export type ScatterScale = "log" | "linear";

export type ScatterCategory = "error" | "fallback" | "governance" | "normal";

/** The value the vertical axis encodes for the selected metric. */
export function metricValue(point: ScatterPoint, metric: ScatterMetric): number {
  switch (metric) {
    case "first_chunk":
      return point.first_chunk_ms;
    case "tokens":
      return point.total_tokens;
    case "cost":
      return point.cost_krw;
    case "risk":
      return point.risk_score;
    case "health":
      return point.health_score;
    default:
      return point.latency_ms;
  }
}

/** Status bucket a point belongs to, mirroring the legacy XView colouring. */
export function pointCategory(point: ScatterPoint): ScatterCategory {
  if (point.status_code >= 400) return "error";
  if (point.failover) return "fallback";
  if (point.policy_decision_count > 0) return "governance";
  return "normal";
}
