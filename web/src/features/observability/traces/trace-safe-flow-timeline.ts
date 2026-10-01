import type { TraceSafeFlow } from "@/shared/api/domains/trace-safe-flow.schema";

/** Visual approximation only. Text preserves the signed integer record values. */
export function flowTimeline(spans: TraceSafeFlow["spans"]) {
  let lower = 0;
  let upper = 0;
  for (const row of spans) {
    if (row.offset_ms === null) continue;
    lower = Math.min(lower, row.offset_ms);
    upper = Math.max(upper, row.offset_ms + (row.duration_ms ?? 0));
  }
  const width = upper - lower;
  return spans.map((row) => {
    if (row.offset_ms === null) return undefined;
    const left = width > 0 ? ((row.offset_ms - lower) / width) * 100 : 0;
    const size = width > 0 ? ((row.duration_ms ?? 0) / width) * 100 : 0;
    return {
      left: Math.max(0, Math.min(100, left)),
      width: Math.max(0, Math.min(100 - left, size)),
      point: row.duration_ms === null || row.duration_ms === 0,
    };
  });
}
