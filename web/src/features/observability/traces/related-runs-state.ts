import { traceRelatedQueryKeys, validTraceRelatedQueryValue } from "@/shared/utils/trace-related-query";
import type { TraceRelatedRunsQuery } from "@/shared/api/domains/trace-related-runs.schema";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { requestQueryFieldError } from "@/shared/utils/request-query-filters";

export function relatedRunsCriteria(search: URLSearchParams, prefixes: readonly string[]) {
  if (!search.has("trace_id")) return { state: "absent" as const };
  const traceId = search.get("trace_id") ?? "";
  const kind = search.get("related_kind") ?? "workflow";
  const limit = search.get("related_limit") ?? "25";
  const offset = search.get("related_offset") ?? "0";
  if (
    ["trace_id", "related_kind", "related_limit", "related_offset"].some(
      (key) => search.getAll(key).length > 1,
    ) ||
    !traceId ||
    requestQueryFieldError("trace_id", traceId) ||
    containsPotentialSecret(traceId, prefixes) ||
    /[\p{C}/]/u.test(traceId) ||
    traceRelatedQueryKeys.some(
      (key) => search.has(key) && !validTraceRelatedQueryValue(key, search.getAll(key)),
    ) ||
    Number(offset) % Number(limit) !== 0
  )
    return { state: "invalid" as const };
  return {
    state: "ready" as const,
    traceId,
    query: {
      kind: kind as "workflow" | "app",
      limit: Number(limit) as 25 | 50 | 100,
      offset: Number(offset),
    } satisfies TraceRelatedRunsQuery,
  };
}
export function relatedRunsSearch(search: URLSearchParams, update: Partial<TraceRelatedRunsQuery>) {
  const next = new URLSearchParams(search);
  for (const [key, value] of Object.entries(update)) next.set(`related_${key}`, String(value));
  return next;
}
