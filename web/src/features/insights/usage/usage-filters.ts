import {
  workActionIds,
  workMaxOffset,
  workMetricIds,
  type WorkMetricId,
  type WorkQuery,
} from "@/shared/api/domains/insights-common";
import type { SearchUpdates } from "@/shared/hooks/use-search-state";

// The filter bar's state lives in the URL. This module reads it, validates it and
// turns it into the query every analytics read shares. Nothing here touches React.

export const usageTabs = [
  "summary",
  "categories",
  "teams",
  "models",
  "trends",
  "sessions",
  "productivity",
] as const;
export type UsageTab = (typeof usageTabs)[number];

export const usageTabLabels: Readonly<Record<UsageTab, string>> = {
  summary: "요약",
  categories: "업무 유형",
  teams: "조직",
  models: "모델",
  trends: "트렌드·자동화",
  sessions: "세션·요청",
  productivity: "생산성",
};

export const periodPresets = [7, 30, 90] as const;
export type PeriodPreset = (typeof periodPresets)[number];
export const defaultPreset: PeriodPreset = 30;
/** Aggregates are kept for 400 days by default; a longer custom range cannot be answered. */
export const maxPeriodDays = 400;

export type UsagePeriod =
  { kind: "preset"; days: PeriodPreset } | { kind: "custom"; from: string; to: string };

export interface DayRange {
  from: string;
  to: string;
}

export interface UsageFilters {
  period: UsagePeriod;
  /** A custom range was in the URL but could not be used; the default period is shown instead. */
  invalidPeriod: boolean;
  compare: boolean;
  team: string;
  category: string;
  action: string;
  model: string;
  client: string;
  metric: WorkMetricId;
}

/** Every URL key the filter bar owns, in the order "필터 초기화" clears them. */
export const filterKeys = [
  "days",
  "from",
  "to",
  "compare",
  "team",
  "category",
  "action",
  "model",
  "client",
  "metric",
] as const;

const dayPattern = /^(\d{4})-(\d{2})-(\d{2})$/u;
const dayMs = 86_400_000;

/** Milliseconds at UTC midnight of a `YYYY-MM-DD` day, or undefined when it is not a real date. */
export function dayToUtc(value: string): number | undefined {
  const match = dayPattern.exec(value);
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? time
    : undefined;
}

export const utcToDay = (time: number): string => new Date(time).toISOString().slice(0, 10);

export function addDays(day: string, amount: number): string {
  const time = dayToUtc(day);
  return time === undefined ? day : utcToDay(time + amount * dayMs);
}

/** Days in an inclusive range; 0 when either end is invalid or the range is reversed. */
export function rangeDays(range: DayRange): number {
  const from = dayToUtc(range.from);
  const to = dayToUtc(range.to);
  if (from === undefined || to === undefined || to < from) return 0;
  return Math.round((to - from) / dayMs) + 1;
}

/** Today's calendar date in Seoul, which is how the server buckets days. */
export function seoulToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** The inclusive day range a period covers: a preset ends today and spans `days` days. */
export function periodRange(period: UsagePeriod, today: string): DayRange {
  if (period.kind === "custom") return { from: period.from, to: period.to };
  return { from: addDays(today, -(period.days - 1)), to: today };
}

/** The range of the same length that ends the day before `range` starts. */
export function previousRange(range: DayRange): DayRange {
  const days = Math.max(1, rangeDays(range));
  const to = addDays(range.from, -1);
  return { from: addDays(to, -(days - 1)), to };
}

export function validCustomRange(from: string, to: string): boolean {
  const days = rangeDays({ from, to });
  return days >= 1 && days <= maxPeriodDays;
}

const controlCharacters = /\p{C}/u;

/** A free-text filter value from the URL: trimmed, bounded and without control characters. */
export function safeText(value: string | null, limit = 128): string {
  const text = (value ?? "").trim();
  return text && [...text].length <= limit && !controlCharacters.test(text) ? text : "";
}

const categoryIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9][A-Za-z0-9_-]*){0,3}$/u;

/** Category IDs are slugs joined by dots (`dev`, `dev.codegen`, `dev.codegen.api`). */
export function safeCategoryId(value: string | null): string {
  const text = (value ?? "").trim();
  return text.length <= 128 && categoryIdPattern.test(text) ? text : "";
}

export function oneOf<Value extends string>(
  value: string | null,
  allowed: readonly Value[],
  fallback: Value,
): Value {
  const text = value ?? "";
  return (allowed as readonly string[]).includes(text) ? (text as Value) : fallback;
}

export function readUsageFilters(params: URLSearchParams): UsageFilters {
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const custom = from !== "" || to !== "";
  const customValid = custom && validCustomRange(from, to);
  const days = periodPresets.find((preset) => String(preset) === params.get("days")) ?? defaultPreset;
  const action = params.get("action") ?? "";
  return {
    period: customValid ? { kind: "custom", from, to } : { kind: "preset", days },
    invalidPeriod: custom && !customValid,
    compare: params.get("compare") !== "none",
    team: safeText(params.get("team")),
    category: safeCategoryId(params.get("category")),
    action: (workActionIds as readonly string[]).includes(action) ? action : "",
    model: safeText(params.get("model"), 160),
    client: safeText(params.get("client")),
    metric: oneOf(params.get("metric"), workMetricIds, "sessions"),
  };
}

/** URL updates that select a preset period (and drop a custom range). */
export function presetUpdates(days: PeriodPreset): SearchUpdates {
  return { days: days === defaultPreset ? undefined : days, from: undefined, to: undefined, page: undefined };
}

/** URL updates that select a custom range; an invalid range changes nothing. */
export function customRangeUpdates(from: string, to: string): SearchUpdates | undefined {
  if (!validCustomRange(from, to)) return undefined;
  return { days: undefined, from, to, page: undefined };
}

/** URL updates for "필터 초기화": every filter key is removed, the tab stays. */
export function resetUpdates(): SearchUpdates {
  return Object.fromEntries([...filterKeys, "page"].map((key) => [key, undefined]));
}

/** How many filters narrow the data (period, comparison and metric do not). */
export function narrowingCount(filters: UsageFilters): number {
  return [filters.team, filters.category, filters.action, filters.model, filters.client].filter(Boolean)
    .length;
}

/** True when the URL carries any filter-bar value that differs from the defaults. */
export function isDefaultFilters(filters: UsageFilters): boolean {
  return (
    narrowingCount(filters) === 0 &&
    filters.compare &&
    filters.metric === "sessions" &&
    filters.period.kind === "preset" &&
    filters.period.days === defaultPreset &&
    !filters.invalidPeriod
  );
}

/** The query every analytics read shares. Empty filters are left out, not sent as "". */
export function filtersQuery(filters: UsageFilters, today: string): WorkQuery {
  const range = periodRange(filters.period, today);
  return {
    from: range.from,
    to: range.to,
    compare: filters.compare ? "prev" : "none",
    ...(filters.team ? { team: filters.team } : {}),
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.model ? { model: filters.model } : {}),
    ...(filters.client ? { client: filters.client } : {}),
    metric: filters.metric,
  };
}

/**
 * The query the filter option lists (and breadcrumb names) are read with. It
 * depends on the period only, so narrowing one filter never empties another's list.
 */
export function optionsQuery(range: DayRange): WorkQuery {
  return { from: range.from, to: range.to, compare: "none", metric: "sessions" };
}

/** A trend over a short period reads by day; a long one by week. */
export function defaultBucket(range: DayRange): "day" | "week" {
  return rangeDays(range) > 45 ? "week" : "day";
}

/** Positive 1-based page from the URL as a 0-based index; a page past the server's largest offset is the first. */
export function pageIndex(value: string | null, pageSize: number): number {
  const page = Number(value);
  return Number.isSafeInteger(page) && page >= 1 && (page - 1) * pageSize <= workMaxOffset ? page - 1 : 0;
}
