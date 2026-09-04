import type { AppRequestSummary, AppRequestsQuery } from "@/shared/api/schemas";
import { isAppRequestRef } from "@/shared/api/app-request-ref";
import { httpStatusTone, type HTTPStatusTone } from "@/shared/utils/http-status";
import { fitsUTF8Bytes } from "@/shared/utils/utf8";
import { isValidRequestTimeZone, validateRequestTimeFilters } from "@/shared/utils/request-time-filters";
import { requestQueryFieldError } from "@/shared/utils/request-query-filters";

const defaultLimit = 50;
const defaultTimeZone = "Asia/Seoul";
const requestStatusPattern = /^(?:success|error|4xx|5xx|[1-5][0-9]{2})$/u;
export const traceSubmittedFilterKeys = ["trace_id", "from", "to", "status", "model", "limit", "tz"] as const;

export interface TraceTimelineLane {
  offsetPercent: number;
  request: AppRequestSummary;
  startOffsetMs: number;
  widthPercent: number;
}

export interface TraceTimelineLayout {
  lanes: readonly TraceTimelineLane[];
  spanMs: number;
}

export type TraceStatusTone = HTTPStatusTone;

export function traceStatusTone(code: number): TraceStatusTone {
  return httpStatusTone(code);
}

function boundedParameter(search: URLSearchParams, key: string, maximumLength: number): string | undefined {
  const value = search.get(key)?.trim();
  return value && fitsUTF8Bytes(value, maximumLength) ? value : undefined;
}

export function buildTraceQuery(search: URLSearchParams): AppRequestsQuery {
  const requestedLimit = Number(search.get("limit"));
  const limit =
    Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 200
      ? requestedLimit
      : defaultLimit;
  const status = boundedParameter(search, "status", 16);
  const from = boundedParameter(search, "from", 64);
  const to = boundedParameter(search, "to", 64);
  const model = boundedParameter(search, "model", 256);
  const traceId = boundedParameter(search, "trace_id", 512);
  const cursor = boundedParameter(search, "cursor", 4_096);
  const requestedTimeZone = boundedParameter(search, "tz", 64) ?? "";
  const temporalError = validateRequestTimeFilters({ from, to, tz: requestedTimeZone });

  return {
    limit,
    tz: isValidRequestTimeZone(requestedTimeZone) ? requestedTimeZone : defaultTimeZone,
    ...(from && temporalError?.field !== "from" ? { from } : {}),
    ...(to && temporalError?.field !== "to" ? { to } : {}),
    ...(status && requestStatusPattern.test(status) && !requestQueryFieldError("status", status)
      ? { status }
      : {}),
    ...(model && !requestQueryFieldError("model", model) ? { model } : {}),
    ...(traceId && !requestQueryFieldError("trace_id", traceId) ? { trace_id: traceId } : {}),
    ...(cursor && !requestQueryFieldError("cursor", cursor) ? { cursor } : {}),
  };
}

export function traceFilterFormKey(search: URLSearchParams): string {
  return JSON.stringify(traceSubmittedFilterKeys.map((key) => search.getAll(key)));
}

export interface TraceRequestSelection {
  kind: "id" | "ref";
  value: string;
}

export function selectedRequestFromSearch(search: URLSearchParams): TraceRequestSelection | undefined {
  const requestIds = search.getAll("selected_request");
  const requestRefs = search.getAll("selected_ref");
  if (requestIds.length + requestRefs.length !== 1) return undefined;

  if (requestRefs.length === 1) {
    const selectedRef = requestRefs[0] ?? "";
    return isAppRequestRef(selectedRef) ? { kind: "ref", value: selectedRef } : undefined;
  }

  const selectedId = boundedParameter(search, "selected_request", 512);
  return selectedId && !requestQueryFieldError("request_id", selectedId)
    ? { kind: "id", value: selectedId }
    : undefined;
}

export function requestExplorerPath(query: AppRequestsQuery, selectedRequest?: string): string {
  const target = new URLSearchParams();
  const filters = [
    ["from", query.from],
    ["to", query.to],
    ["status", query.status],
    ["model", query.model],
    ["trace_id", query.trace_id],
    ["limit", query.limit],
    ["tz", query.tz],
  ] as const;
  for (const [key, value] of filters) {
    if (value !== undefined && value !== "") target.set(key, String(value));
  }
  if (selectedRequest) target.set("request_id", selectedRequest);
  const serialized = target.toString();
  return `/observability/requests${serialized ? `?${serialized}` : ""}`;
}

function requestStartMs(request: AppRequestSummary): number {
  const timestamp = Date.parse(request.created_at);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function orderTraceRequests(requests: readonly AppRequestSummary[]): readonly AppRequestSummary[] {
  return [...requests].sort(
    (left, right) =>
      requestStartMs(left) - requestStartMs(right) || left.request_ref.localeCompare(right.request_ref),
  );
}

export function buildTraceTimeline(requests: readonly AppRequestSummary[]): TraceTimelineLayout {
  if (requests.length === 0) return { lanes: [], spanMs: 0 };

  const ordered = orderTraceRequests(requests);
  const firstStart = requestStartMs(ordered[0] as AppRequestSummary);
  const lastEnd = ordered.reduce(
    (latest, request) => Math.max(latest, requestStartMs(request) + request.latency_ms),
    firstStart,
  );
  const spanMs = Math.max(1, lastEnd - firstStart);
  const lanes = ordered.map((request) => {
    const startOffsetMs = Math.max(0, requestStartMs(request) - firstStart);
    const rawOffset = (startOffsetMs / spanMs) * 100;
    const offsetPercent = Math.min(98.5, Math.max(0, rawOffset));
    const requestedWidth = Math.max(1.5, (request.latency_ms / spanMs) * 100);
    const widthPercent = Math.min(requestedWidth, 100 - offsetPercent);
    return { offsetPercent, request, startOffsetMs, widthPercent };
  });

  return { lanes, spanMs };
}

export function traceCount(requests: readonly AppRequestSummary[]): number {
  return new Set(requests.map((request) => request.trace_id).filter(Boolean)).size;
}

export function formatTraceDate(
  value: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "확인 불가";
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      ...options,
      timeZone: timeZone || defaultTimeZone,
    }).format(date);
  } catch {
    return "확인 불가";
  }
}

export function formatTraceDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds.toLocaleString("ko-KR")}ms`;
  return `${(milliseconds / 1_000).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}초`;
}
