import { describe, expect, it } from "vitest";
import { flightRecorderEventSchema } from "@/shared/api/domains/observability.schemas";
import { defaultFlightEventFilters as defaults, selectFlightEvents } from "./flight-event-filters";

const events = [
  { request_id: "normal", kind: "chat", status_code: 200 },
  { request_id: "stored-error", kind: "chat", status_code: 200, is_error: true, secret_events: 2 },
  { request_id: "blocked", kind: "messages", policy_blocks: 1 },
  { request_id: "high-code", kind: "responses", code_risk: "high" },
  { request_id: "low-code", kind: "embedding", code_risk: "low", tool_count: 3 },
  { request_id: "unknown", kind: "future-kind", tool_count: 1 },
].map((event) => flightRecorderEventSchema.parse(event));

describe("세션 수신 기록 선택", () => {
  it("uses the server error marker including HTTP 200 errors", () => {
    expect(
      selectFlightEvents(events, { ...defaults, signal: "error" }).map(({ event }) => event.request_id),
    ).toEqual(["stored-error"]);
  });
  it("counts a multi-signal request once and intersects kind and signal", () => {
    const risk = selectFlightEvents(events, { ...defaults, signal: "risk" });
    expect(risk.map(({ event }) => event.request_id)).toEqual(["stored-error", "blocked", "high-code"]);
    expect(
      selectFlightEvents(events, { ...defaults, signal: "risk", kind: "messages" }).map(
        ({ event }) => event.request_id,
      ),
    ).toEqual(["blocked"]);
  });
  it("includes unknown and empty types in other without assuming success or risk", () => {
    expect(
      selectFlightEvents([...events, flightRecorderEventSchema.parse({ kind: "" })], {
        ...defaults,
        kind: "other",
      }),
    ).toHaveLength(2);
    expect(selectFlightEvents(events, { ...defaults, kind: "other", signal: "risk" })).toEqual([]);
  });
  it("preserves source ordinals and does not mutate chronology when reversed", () => {
    const before = JSON.stringify(events);
    expect(
      selectFlightEvents(events, { ...defaults, signal: "tools", order: "newest" }).map(
        ({ ordinal }) => ordinal,
      ),
    ).toEqual([6, 5]);
    expect(JSON.stringify(events)).toBe(before);
    expect(selectFlightEvents([], defaults)).toEqual([]);
  });
});
