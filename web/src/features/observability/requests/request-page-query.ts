import type { AppRequestsQuery } from "@/shared/api/schemas";
import { requestQueryFieldError } from "@/shared/utils/request-query-filters";
import { isValidRequestTimeZone, validateRequestTimeFilters } from "@/shared/utils/request-time-filters";

export const filterKeys = [
  "from",
  "to",
  "status",
  "model",
  "provider_ref",
  "request_id",
  "trace_id",
  "session_id",
  "api_key_id",
  "ip",
  "language",
] as const;
export const defaultLimit = 50;
export const defaultTimeZone = "Asia/Seoul";
export const exactHTTPStatusPattern = /^[1-5][0-9]{2}$/u;
export const standardPageLimits = [25, 50, 100, 200] as const;

export function queryFromSearch(search: URLSearchParams): AppRequestsQuery {
  const requestedLimit = Number(search.get("limit"));
  const temporalError = validateRequestTimeFilters({
    from: search.get("from") ?? undefined,
    to: search.get("to") ?? undefined,
    tz: search.get("tz") ?? undefined,
  });
  const requestedTimeZone = search.get("tz")?.trim() ?? "";
  const query: AppRequestsQuery = {
    limit:
      Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 200
        ? requestedLimit
        : defaultLimit,
    tz: isValidRequestTimeZone(requestedTimeZone) ? requestedTimeZone : defaultTimeZone,
  };
  for (const key of filterKeys) {
    const value = search.get(key)?.trim();
    if (value && requestQueryFieldError(key, value)) continue;
    if ((key === "from" || key === "to") && temporalError?.field === key) continue;
    if (value) Object.assign(query, { [key]: value });
  }
  const cursor = search.get("cursor");
  if (cursor && !requestQueryFieldError("cursor", cursor)) query.cursor = cursor;
  return query;
}
