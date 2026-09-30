import { describe, expect, it } from "vitest";
import { requestTraceSchema } from "@/shared/api/domains/observability.schemas";
import {
  flowCount,
  flowInteger,
  flowKind,
  flowMilliseconds,
  flowScale,
  flowSessionHref,
  flowText,
  hiddenFlowText,
} from "./request-flow-display";

describe("local request-flow presentation helpers", () => {
  it.each([
    { label: "absent", value: undefined },
    { label: "null", value: null },
    { label: "negative", value: -1 },
    { label: "fraction", value: 1.5 },
    { label: "NaN", value: Number.NaN },
    { label: "infinity", value: Number.POSITIVE_INFINITY },
    { label: "negative infinity", value: Number.NEGATIVE_INFINITY },
    { label: "unsafe integer", value: Number.MAX_SAFE_INTEGER + 1 },
  ])("does not render $label as zero or a confirmed count/time", ({ value }) => {
    expect(flowInteger(value)).toBeUndefined();
    expect(flowCount(value, "건")).toBe("미확인");
    expect(flowMilliseconds(value)).toBe("미확인");
    // Direct helper values, not a claim that every malformed number passes Zod/JSON.
  });

  it("keeps explicit zero and exact valid recorded integers", () => {
    expect(flowCount(0, "건")).toBe("0건");
    expect(flowMilliseconds(0)).toBe("0ms");
    expect(flowMilliseconds(1201)).toBe("1,201ms");
    expect(flowCount(42, "건")).toBe("42건");
  });

  it("keeps valid scale semantics without treating the scale as actual end time", () => {
    const trace = requestTraceSchema.parse({
      spans: [
        { span_id: "root", start_offset_ms: 0, duration_ms: 120 },
        { span_id: "stage", start_offset_ms: 300, duration_ms: 40 },
      ],
    });
    expect(flowScale(trace.spans, 340)).toBe(340);
    expect(flowScale(trace.spans, 120)).toBe(340);
  });

  it("ignores invalid plotting numbers instead of creating nonfinite CSS coordinates", () => {
    const trace = requestTraceSchema.parse({
      spans: [
        { span_id: "unknown" },
        { span_id: "negative", start_offset_ms: -100, duration_ms: 20 },
        { span_id: "unsafe-sum", start_offset_ms: Number.MAX_SAFE_INTEGER, duration_ms: 1 },
      ],
    });
    expect(flowScale(trace.spans, Number.POSITIVE_INFINITY)).toBe(1);
  });

  it("scans many records without variadic Math.max argument limits", () => {
    const trace = requestTraceSchema.parse({
      spans: [{ span_id: "record", start_offset_ms: 1, duration_ms: 2 }],
    });
    expect(
      flowScale(
        Array.from({ length: 150_000 }, () => trace.spans[0]).filter((row) => row !== undefined),
        1,
      ),
    ).toBe(3);
    // Arithmetic helper only: no UI rendering cap or server response bound proof.
  });

  it.each(["constructor", "__proto__", "toString"])(
    "renders unknown kind %s as text, never a prototype property",
    (kind) => {
      expect(flowKind(kind, [])).toBe(`종류 미확인 (${kind})`);
    },
  );

  it("masks configured credentials at literal and encoded layers", () => {
    const marker = `%41_${"a".repeat(36)}`;
    expect(flowText(marker, ["%41_"])).toBe(hiddenFlowText);
    expect(flowKind(encodeURIComponent(marker), ["%41_"])).not.toContain(marker);
    expect(flowKind(encodeURIComponent(marker), ["%41_"])).not.toContain(encodeURIComponent(marker));
    expect(flowSessionHref(marker, ["%41_"])).toBeUndefined();
    expect(flowSessionHref(encodeURIComponent(marker), ["%41_"])).toBeUndefined();
  });

  it("does not promote a server redaction placeholder to a session navigation identity", () => {
    expect(flowSessionHref("[REDACTED_EMAIL]", [])).toBeUndefined();
    expect(flowSessionHref("", [])).toBeUndefined();
    expect(flowSessionHref(undefined, [])).toBeUndefined();
  });

  it("keeps valid public Unicode session identifiers encoded without a duplicate basename", () => {
    expect(flowSessionHref("공개 세션/1", [])).toBe(
      `/observability/xview?session_id=${encodeURIComponent("공개 세션/1")}`,
    );
  });

  it("does not crash the card when a returned session ID cannot be URI encoded", () => {
    expect(flowSessionHref("\ud800", [])).toBeUndefined();
  });
});
