import type { TraceTimelineLane } from "./trace-utils";
export interface TraceTimelineGroupData {
  key: string;
  traceId: string | null;
  rows: { lane: TraceTimelineLane; ordinal: number }[];
  errors: number;
  unknownStatuses: number;
  maxLatency: number;
}
export function groupTraceTimeline(lanes: readonly TraceTimelineLane[]): TraceTimelineGroupData[] {
  const groups = new Map<string, TraceTimelineGroupData>();
  lanes.forEach((lane, index) => {
    const request = lane.request;
    // Redacted identifiers are display placeholders, never identities. Do not merge them.
    const traceId = request.trace_filterable && request.trace_id ? request.trace_id : null;
    const key = traceId === null ? `request:${request.request_ref}` : `trace:${traceId}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, traceId, rows: [], errors: 0, unknownStatuses: 0, maxLatency: 0 };
      groups.set(key, group);
    }
    group.rows.push({ lane, ordinal: index + 1 });
    if (request.status_code >= 400 && request.status_code < 600) group.errors += 1;
    if (request.status_code < 100 || request.status_code >= 600) group.unknownStatuses += 1;
    group.maxLatency = Math.max(group.maxLatency, request.latency_ms);
  });
  return [...groups.values()];
}
