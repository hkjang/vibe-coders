import type { WorkMetricId, WorkMetrics } from "@/shared/api/domains/insights-common";
import { formatKRW, formatNumber } from "@/shared/utils/format";

export const metricLabels: Readonly<Record<WorkMetricId, string>> = {
  sessions: "업무 세션 수",
  requests: "API 호출 수",
  users: "고유 사용자 수",
  tokens: "토큰 사용량",
  cost: "비용",
  mcp_calls: "MCP 도구 호출 수",
};

export const metricShortLabels: Readonly<Record<WorkMetricId, string>> = {
  sessions: "세션",
  requests: "요청",
  users: "사용자",
  tokens: "토큰",
  cost: "비용",
  mcp_calls: "MCP 호출",
};

/** What a withheld value reads as, everywhere: cells, tiles, tooltips and table views. */
export const suppressedLabel = "보호됨";

/** Why a value is withheld, for tooltips. */
export function suppressedHint(minGroupSize: number): string {
  return `고유 사용자가 ${formatNumber(minGroupSize)}명 미만인 집계와, 다른 값에서 빼서 그런 집계를 알아낼 수 있는 집계는 개인을 추정할 수 없도록 값을 가립니다.`;
}

/** The value of one metric; `null` when the group is withheld (or, for users alone, unknown). */
export function metricValue(metrics: WorkMetrics, metric: WorkMetricId): number | null {
  if (metrics.suppressed) return null;
  switch (metric) {
    case "sessions":
      return metrics.sessions;
    case "requests":
      return metrics.requests;
    case "users":
      return metrics.users;
    case "tokens":
      return metrics.tokens;
    case "cost":
      return metrics.cost_krw;
    case "mcp_calls":
      return metrics.mcp_calls;
  }
}

export function formatMetric(value: number | null | undefined, metric: WorkMetricId): string {
  return metric === "cost" ? formatKRW(value) : formatNumber(value);
}

const compact = new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 });

/** Short form for axis ticks: 12,300 → "1.2만". */
export function formatMetricCompact(value: number, metric: WorkMetricId): string {
  if (!Number.isFinite(value)) return "—";
  return metric === "cost" ? `₩${compact.format(value)}` : compact.format(value);
}

/** Relative change from `previous` to `current`; undefined when there is no base to compare with. */
export function changeRate(
  current: number | null | undefined,
  previous: number | null | undefined,
): number | undefined {
  if (current === null || current === undefined || previous === null || previous === undefined) {
    return undefined;
  }
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return undefined;
  return (current - previous) / Math.abs(previous);
}

/** "▲ 12.3%" / "▼ 4.0%" / "변화 없음"; a dash when the rate is unknown. The arrow carries the direction, not a colour. */
export function formatChange(rate: number | null | undefined, digits = 1): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "—";
  const percent = Math.abs(rate * 100);
  if (percent < 0.05) return "변화 없음";
  return `${rate > 0 ? "▲" : "▼"} ${percent.toFixed(digits)}%`;
}

/** Signed absolute change: "+1,234" / "−56". */
export function formatSigned(value: number | null | undefined, metric: WorkMetricId = "sessions"): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  return `${value > 0 ? "+" : "−"}${formatMetric(Math.abs(value), metric)}`;
}

/** Percentage-point difference between two ratios: "+2.1%p". */
export function formatPointChange(current: number, previous: number | null | undefined): string {
  if (previous === null || previous === undefined || !Number.isFinite(previous)) return "—";
  const points = (current - previous) * 100;
  if (Math.abs(points) < 0.05) return "변화 없음";
  return `${points > 0 ? "+" : "−"}${Math.abs(points).toFixed(1)}%p`;
}
