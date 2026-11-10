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

export const scatterCategories = ["normal", "governance", "fallback", "error"] as const;
export type ScatterCategory = (typeof scatterCategories)[number];

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

/** Nearest-rank percentile of already sorted values. */
export function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

/** Lifts the baseline so zero-valued markers do not sit half inside the axis labels. */
const baselineGap = 0.03;
const lifted = (ratio: number): number => baselineGap + (1 - baselineGap) * ratio;

export interface YScale {
  /** Maps a value to 0 (bottom of the plot) .. 1 (top). */
  ratio: (value: number) => number;
  ticks: readonly number[];
}

/** A round step such that about `count` steps span `max`: 1, 2 or 5 times a power of ten. */
function niceStep(max: number, count: number): number {
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
}

/**
 * Round axis values rather than fractions of the maximum, which read as 1,778ms. The log
 * axis starts at the smallest positive value's decade so sub-won costs do not all collapse
 * onto the baseline, and a non-positive value sits on the baseline instead of breaking it.
 */
export function yScale(values: readonly number[], scale: ScatterScale): YScale {
  const max = values.reduce((highest, value) => Math.max(highest, value), 0);
  if (scale === "linear") {
    if (max <= 0) return { ratio: () => lifted(0), ticks: [0] };
    const step = niceStep(max, 4);
    const top = Math.ceil(max / step) * step;
    const ticks: number[] = [];
    for (let tick = 0; tick <= top + step / 2; tick += step) ticks.push(tick);
    return { ratio: (value) => lifted(Math.min(1, Math.max(0, value / top))), ticks };
  }
  const smallest = values.reduce(
    (lowest, value) => (value > 0 && value < lowest ? value : lowest),
    Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(smallest)) return { ratio: () => lifted(0), ticks: [1] };
  const low = Math.floor(Math.log10(smallest));
  const high = Math.max(low + 1, Math.ceil(Math.log10(max)));
  const stride = Math.max(1, Math.ceil((high - low) / 5));
  const ticks: number[] = [];
  for (let exponent = low; exponent <= high; exponent += stride) ticks.push(10 ** exponent);
  return {
    ratio: (value) =>
      value <= 0 ? 0 : lifted(Math.min(1, Math.max(0, (Math.log10(value) - low) / (high - low)))),
    ticks,
  };
}

const timeSteps = [
  1_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000,
  10_800_000, 21_600_000, 43_200_000, 86_400_000,
];

/** Clock-aligned instants across the domain, so the axis reads 14:05, 14:10 rather than raw edges. */
export function timeTicks(from: number, to: number, count = 6): readonly number[] {
  const span = to - from;
  if (!(span > 0)) return [from];
  const step = timeSteps.find((candidate) => span / candidate <= count) ?? 86_400_000;
  const ticks: number[] = [];
  for (let tick = Math.ceil(from / step) * step; tick <= to; tick += step) ticks.push(tick);
  return ticks;
}

export function formatTimeTick(value: number, span: number, timeZone: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone,
    hour12: false,
    ...(span > 86_400_000 ? { month: "2-digit", day: "2-digit" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    ...(span < 180_000 ? { second: "2-digit" } : {}),
  }).format(value);
}

export interface PlottedPoint {
  point: ScatterPoint;
  x: number;
  y: number;
}

/** A linear scan of at most 6,000 points per pointer move stays well under a frame. */
export function nearestPlottedPoint(
  plotted: readonly PlottedPoint[],
  x: number,
  y: number,
  radius: number,
): PlottedPoint | undefined {
  let best: PlottedPoint | undefined;
  let bestDistance = radius * radius;
  for (const candidate of plotted) {
    const dx = candidate.x - x;
    if (dx > radius || dx < -radius) continue;
    const dy = candidate.y - y;
    const distance = dx * dx + dy * dy;
    // Later points were drawn on top, so they win a tie.
    if (distance <= bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

export interface SelectionSummary {
  count: number;
  errors: number;
  fallbacks: number;
  p50: number;
  p95: number;
  totalTokens: number;
  totalCost: number;
}

export function summarizeSelection(points: readonly ScatterPoint[]): SelectionSummary {
  const latencies = points.map((point) => point.latency_ms).sort((left, right) => left - right);
  return {
    count: points.length,
    errors: points.filter((point) => point.status_code >= 400).length,
    fallbacks: points.filter((point) => point.failover).length,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    totalTokens: points.reduce((sum, point) => sum + point.total_tokens, 0),
    totalCost: points.reduce((sum, point) => sum + point.cost_krw, 0),
  };
}

const flowStageLabels: Readonly<Record<string, string>> = {
  auth: "인증",
  quota: "할당량",
  skill: "스킬",
  governance: "거버넌스",
  routing: "라우팅",
  cache: "캐시",
  mcp: "MCP 도구",
  text2sql: "Text2SQL",
  upstream: "업스트림 호출",
  dw: "데이터 웨어하우스 적재",
};

const flowStatusLabels: Readonly<Record<string, string>> = {
  ok: "정상",
  skip: "해당 없음",
  warn: "주의",
  fallback: "폴백",
  blocked: "차단",
  error: "오류",
};

export const flowStageLabel = (stage: string): string => flowStageLabels[stage] ?? stage;
export const flowStatusLabel = (status: string): string => flowStatusLabels[status] ?? status;

// The server words these as log messages; the rest it composes from recorded values.
const flowDecisionLabels: Readonly<Record<string, string>> = {
  "api_key resolved": "API 키 확인",
  allowed: "허용",
  "no quota decision recorded": "할당량 판단 기록 없음",
  "per-request skill attribution not tracked": "요청별 스킬 귀속을 추적하지 않음",
  "no routing decision recorded": "라우팅 판단 기록 없음",
  "no per-request cache record": "요청별 캐시 기록 없음",
  "cached prompt tokens": "프롬프트 토큰 캐시 적중",
  "no MCP tools in this request": "이 요청에 MCP 도구 없음",
  "not a Text2SQL request": "Text2SQL 요청 아님",
  "ClickHouse fact sink not configured": "ClickHouse 적재 미설정",
};

export const flowDecisionLabel = (decision: string): string => flowDecisionLabels[decision] ?? decision;
