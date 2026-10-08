import type { ScatterPoint } from "@/shared/api/domains/observability.schemas";

export const liveIntervalMs = 1_500;
export const maxLivePoints = 6_000;
export const reconcileIntervalMs = 15_000;
export const refreshIntervalMs = 300_000;
export const catchUpIntervalMs = 25;
export const maxCatchUpPages = 20;

export interface XViewFilters {
  window?: string;
  from?: string;
  to?: string;
  tz?: string;
  models?: string;
  endpoint?: string;
}
export interface XViewClock {
  serverAt: number;
  receivedAt: number;
  reportedAt: number;
  confirmed: boolean;
}
export type XViewLiveStatus = "waiting" | "live" | "catching-up" | "hidden" | "retrying" | "stalled";
export interface XViewBuffer {
  points: ReadonlyArray<ScatterPoint>;
  truncated: boolean;
  clock?: XViewClock;
  lastUpdatedAt: number;
  status: XViewLiveStatus;
  error?: string;
}

const durations: Record<string, number> = {
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "6h": 21_600_000,
  "24h": 86_400_000,
};
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
export function serverTimestamp(value: string): number | undefined {
  if (!timestamp.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Never substitute the browser wall clock for an unconfirmed server clock. */
export function updateXViewClock(previous: XViewClock | undefined, value: string, now: number) {
  const reportedAt = serverTimestamp(value);
  if (reportedAt === undefined || (previous && reportedAt < previous.reportedAt))
    return previous ? { ...previous, confirmed: false } : undefined;
  if (previous && reportedAt === previous.reportedAt) return { ...previous, confirmed: true };
  return {
    reportedAt,
    serverAt: Math.max(reportedAt, previous ? estimatedServerTime(previous, now) : reportedAt),
    receivedAt: now,
    confirmed: true,
  };
}
export function estimatedServerTime(clock: XViewClock, now: number): number {
  return clock.serverAt + Math.max(0, now - clock.receivedAt);
}
function samePoint(left: ScatterPoint, right: ScatterPoint): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

/** Repeated/empty deltas preserve the array so the 6,000-dot plot need not redraw. */
export function mergeXViewPoints(
  base: ReadonlyArray<ScatterPoint>,
  incoming: ReadonlyArray<ScatterPoint>,
  filters: XViewFilters,
  clock: XViewClock | undefined,
  now: number,
): { points: ReadonlyArray<ScatterPoint>; truncated: boolean } {
  const duration = !filters.from && !filters.to ? durations[filters.window ?? "1h"] : undefined;
  const since = duration && clock ? estimatedServerTime(clock, now) - duration : undefined;
  const visible = (point: ScatterPoint) => {
    const createdAt = serverTimestamp(point.created_at);
    // Unknown timestamps remain visible; the API contract is intentionally unchanged.
    return since === undefined || createdAt === undefined || createdAt >= since;
  };
  const byId = new Map(base.filter(visible).map((point) => [point.request_id, point]));
  let changed = byId.size !== base.length;
  for (const point of incoming) {
    if (!visible(point)) continue;
    const prior = byId.get(point.request_id);
    if (!prior || !samePoint(prior, point)) {
      byId.set(point.request_id, point);
      changed = true;
    }
  }
  const truncated = byId.size > maxLivePoints;
  if (!changed && !truncated) return { points: base, truncated: false };
  const points = [...byId.values()].sort((left, right) => {
    const a = serverTimestamp(left.created_at);
    const b = serverTimestamp(right.created_at);
    return a !== undefined && b !== undefined ? a - b : left.created_at.localeCompare(right.created_at);
  });
  return { points: truncated ? points.slice(-maxLivePoints) : points, truncated };
}

export interface XViewCursor {
  ingested_at: string;
  request_id: string;
}
const goWhitespace =
  // Go's strings.TrimSpace includes these controls and deliberately excludes FEFF.
  // eslint-disable-next-line no-control-regex
  /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu;
export function validXViewCursor(cursor: XViewCursor): boolean {
  return (
    serverTimestamp(cursor.ingested_at) !== undefined &&
    cursor.request_id !== "" &&
    cursor.request_id.replace(goWhitespace, "") === cursor.request_id &&
    new TextEncoder().encode(cursor.request_id).length <= 256
  );
}
export const cursorIdentity = (cursor: XViewCursor): string =>
  JSON.stringify([cursor.ingested_at, cursor.request_id]);

/** Preserve nanoseconds; request IDs are opaque, not locale-sorted database keys. */
export function cursorTime(cursor: XViewCursor): bigint | undefined {
  const milliseconds = serverTimestamp(cursor.ingested_at);
  if (milliseconds === undefined) return undefined;
  const fraction = /\.(\d{1,9})/u.exec(cursor.ingested_at)?.[1] ?? "";
  return BigInt(milliseconds) * 1_000_000n + BigInt(fraction.padEnd(9, "0").slice(3));
}

export function summarizeXView(points: ReadonlyArray<ScatterPoint>) {
  const latencies = points.map((point) => point.latency_ms).sort((left, right) => left - right);
  return {
    total: points.length,
    errors: points.filter((point) => point.status_code >= 400).length,
    fallbacks: points.filter((point) => point.failover).length,
    governance: points.filter((point) => point.policy_decision_count > 0).length,
    p95: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : 0,
  };
}
