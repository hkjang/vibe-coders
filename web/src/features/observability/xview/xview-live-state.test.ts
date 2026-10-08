import { describe, expect, it } from "vitest";
import { scatterPointSchema } from "@/shared/api/domains/observability.schemas";
import {
  cursorTime,
  mergeXViewPoints,
  summarizeXView,
  updateXViewClock,
  validXViewCursor,
} from "./xview-live-state";

const time = Date.parse("2026-10-08T09:00:00Z");
const point = (id: string, latency = 1) =>
  scatterPointSchema.parse({ request_id: id, created_at: "2026-10-08T08:59:30Z", latency_ms: latency });

describe("XView display buffer", () => {
  it("preserves point and array identities for empty and repeated projections", () => {
    const base = [point("one"), point("two")];
    expect(mergeXViewPoints(base, [], { window: "5m" }, undefined, 0).points).toBe(base);
    expect(mergeXViewPoints(base, [point("one")], { window: "5m" }, undefined, 0).points).toBe(base);
    const changed = mergeXViewPoints(base, [point("two", 90)], {}, undefined, 0).points;
    expect(changed).not.toBe(base);
    expect(changed[0]).toBe(base[0]);
    expect(changed[1]).toMatchObject({ latency_ms: 90 });
  });

  it("does not invent a server clock and keeps an existing anchor through invalid responses", () => {
    expect(updateXViewClock(undefined, "", 100)).toBeUndefined();
    const anchor = updateXViewClock(undefined, new Date(time).toISOString(), 100);
    const invalid = updateXViewClock(anchor, "invalid", 10_000);
    expect(invalid).toEqual({ ...anchor, confirmed: false });
    const backward = updateXViewClock(anchor, new Date(time - 1).toISOString(), 10_000);
    expect(backward).toEqual(invalid);
    expect(updateXViewClock(anchor, new Date(time).toISOString(), 10_000)?.receivedAt).toBe(100);
  });

  it("distinguishes nanosecond cursor progress without sorting opaque IDs", () => {
    const first = { ingested_at: "2026-10-08T09:00:00.000000001Z", request_id: "z" };
    const second = { ingested_at: "2026-10-08T09:00:00.000000002Z", request_id: "a" };
    expect(cursorTime(first)).toBe(BigInt(time) * 1_000_000n + 1n);
    expect(cursorTime(second)).toBe(BigInt(time) * 1_000_000n + 2n);
    expect(validXViewCursor({ ...first, request_id: "한글 / ? # % . \\" })).toBe(true);
    expect(validXViewCursor({ ...first, request_id: "\ufeff" })).toBe(true);
    expect(validXViewCursor({ ...first, request_id: "\u0085" })).toBe(false);
    expect(validXViewCursor({ ...first, request_id: "한".repeat(86) })).toBe(false);
  });

  it.each([0, 1, 19, 20, 21, 40])("uses nearest-rank P95 for %i displayed points", (count) => {
    const points = Array.from({ length: count }, (_, index) => point(String(index), index + 1));
    expect(summarizeXView(points)).toMatchObject({ total: count, p95: Math.ceil(count * 0.95) });
  });
});
