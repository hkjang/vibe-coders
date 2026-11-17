export type TraceTimelineView = "time" | "trace";
export function validTraceTimelineView(values: readonly string[]): boolean {
  return values.length === 1 && (values[0] === "time" || values[0] === "trace");
}
export function readTraceTimelineView(search: URLSearchParams): TraceTimelineView {
  const values = search.getAll("timeline_view");
  return validTraceTimelineView(values) && values[0] === "trace" ? "trace" : "time";
}
