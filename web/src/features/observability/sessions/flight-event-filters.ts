import type { FlightRecorderEvent } from "@/shared/api/domains/observability.schemas";

export const flightEventKinds = [
  { value: "all", label: "모든 유형" },
  { value: "chat", label: "대화" },
  { value: "embedding", label: "임베딩" },
  { value: "responses", label: "응답 생성" },
  { value: "messages", label: "메시지" },
  { value: "completion", label: "텍스트 완성" },
  { value: "other", label: "기타 요청" },
] as const;
export const flightEventSignals = [
  { value: "all", label: "모든 기록" },
  { value: "error", label: "오류 기록" },
  { value: "risk", label: "위험 신호 있는 기록" },
  { value: "tools", label: "도구 호출 있는 기록" },
] as const;
export const flightEventOrders = [
  { value: "oldest", label: "첫 기록부터" },
  { value: "newest", label: "최근 기록부터" },
] as const;
export interface FlightEventFilters {
  kind: (typeof flightEventKinds)[number]["value"];
  signal: (typeof flightEventSignals)[number]["value"];
  order: (typeof flightEventOrders)[number]["value"];
}
export const defaultFlightEventFilters: FlightEventFilters = { kind: "all", signal: "all", order: "oldest" };
export interface FlightEventEntry {
  event: FlightRecorderEvent;
  ordinal: number;
}

export function flightEventHasRisk(event: FlightRecorderEvent): boolean {
  return event.secret_events > 0 || event.policy_blocks > 0 || event.code_risk === "high";
}

/** Filter only the authorized response; retain its chronology and original row identity. */
export function selectFlightEvents(
  events: readonly FlightRecorderEvent[],
  filters: FlightEventFilters,
): FlightEventEntry[] {
  const rows = events.flatMap((event, index) => {
    const kind = flightEventKinds.some(
      (option) => option.value !== "all" && option.value !== "other" && option.value === event.kind,
    )
      ? event.kind
      : "other";
    if (filters.kind !== "all" && filters.kind !== kind) return [];
    if (filters.signal === "error" && !event.is_error) return [];
    if (filters.signal === "risk" && !flightEventHasRisk(event)) return [];
    if (filters.signal === "tools" && event.tool_count <= 0) return [];
    return [{ event, ordinal: index + 1 }];
  });
  return filters.order === "newest" ? rows.reverse() : rows;
}
