import type { AdminTimeseries } from "@/shared/api/schemas";
import { formatDateTime } from "@/shared/utils/format";
import { formatPreciseNumber } from "@/shared/utils/precise-number";

export const trendWindows = [
  { id: "1h", label: "최근 1시간", bucket: "hour", heatmap: "7d" },
  { id: "24h", label: "최근 24시간", bucket: "hour", heatmap: "7d" },
  { id: "7d", label: "최근 7일", bucket: "day", heatmap: "7d" },
  { id: "30d", label: "최근 30일", bucket: "day", heatmap: "30d" },
] as const;
export type TrendWindow = (typeof trendWindows)[number]["id"];
export type TrendPoint = AdminTimeseries["points"][number];

/** Server buckets are already Seoul calendar values, never browser-local UTC. */
export function trendBucket(point: Pick<TrendPoint, "date" | "bucket">): { label: string; iso: string } {
  const hourly = point.bucket === "hour";
  const validShape = hourly ? /^\d{4}-\d{2}-\d{2}T\d{2}$/u : /^\d{4}-\d{2}-\d{2}$/u;
  if ((point.bucket !== "day" && !hourly) || !validShape.test(point.date)) {
    return { label: "구간 확인 불가", iso: "" };
  }
  const timestamp = new Date(`${point.date}${hourly ? ":00:00" : "T00:00:00"}+09:00`);
  const local = formatDateTime(timestamp)
    .slice(0, hourly ? 13 : 10)
    .replace(" ", "T");
  if (local !== point.date) return { label: "구간 확인 불가", iso: "" };
  return { label: hourly ? `${point.date.replace("T", " ")}시` : point.date, iso: timestamp.toISOString() };
}

export function trendSince(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return undefined;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined;
}

export function trendCost(value: number): string {
  return `₩${formatPreciseNumber(value)}`;
}
