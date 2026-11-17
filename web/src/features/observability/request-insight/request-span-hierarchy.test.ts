import { describe, expect, it } from "vitest";
import type { RequestTraceSpan } from "@/shared/api/domains/observability.schemas";
import { maximumRecordDepth, spanRecordForest, type SpanRecordNode } from "./request-span-hierarchy";

const span = (id: string, parent?: string): RequestTraceSpan => ({
  span_id: id,
  parent_span_id: parent ?? "",
  name: "처리 기록",
  kind: "request",
  status: "ok",
  error: "",
});
function flatten(roots: SpanRecordNode[]): SpanRecordNode[] {
  return roots.flatMap((node) => [node, ...flatten(node.children)]);
}

describe("record forest preserves declared identity without inventing links", () => {
  it("accepts children before parents, preserves sibling order, and ignores time/name similarity", () => {
    const records = [span("c", "p"), span("z"), span("p"), span("b", "p")];
    const roots = spanRecordForest(records, []);
    expect(roots.map((node) => node.span.span_id)).toEqual(["z", "p"]);
    expect(roots[1]?.children.map((node) => node.span.span_id)).toEqual(["c", "b"]);
    expect(
      flatten(roots)
        .map((node) => node.span)
        .sort((a, b) => a.span_id.localeCompare(b.span_id)),
    ).toEqual([...records].sort((a, b) => a.span_id.localeCompare(b.span_id)));
  });

  it("preserves all duplicate rows and does not attach ambiguous children", () => {
    const roots = spanRecordForest(
      [span("p"), span("p"), span("c", "p"), span("c", "p"), span("missing", "elsewhere")],
      [],
    );
    expect(roots).toHaveLength(5);
    expect(roots.every((node) => node.children.length === 0 && node.note)).toBe(true);
    expect(new Set(roots.map((node) => node.key)).size).toBe(5);
  });

  it.each(["", "[REDACTED]", "vc_sk_private-example", "x\n", "한".repeat(171), "\ud800"])(
    "does not join an unusable or masked identity %s",
    (id) => {
      const roots = spanRecordForest([span(id), span("child", id)], ["vc_sk_"]);
      expect(roots).toHaveLength(2);
      expect(roots[0]?.children).toEqual([]);
      expect(roots[0]?.note).toBeTruthy();
    },
  );

  it("separates every member of a cycle and preserves valid descendants", () => {
    const roots = spanRecordForest(
      [span("leaf", "a"), span("a", "b"), span("b", "c"), span("c", "a"), span("self", "self")],
      [],
    );
    expect(roots.map((node) => node.span.span_id)).toEqual(["a", "b", "c", "self"]);
    expect(roots.every((node) => node.note?.includes("순환"))).toBe(true);
    expect(roots[0]?.children[0]?.span.span_id).toBe("leaf");
    expect(flatten(roots)).toHaveLength(5);
  });

  it("bounds deep nesting without dropping rows, mutating input, or overflowing the stack", () => {
    const records = Array.from({ length: 20000 }, (_, i) =>
      Object.freeze(span(`s${i}`, i ? `s${i - 1}` : undefined)),
    );
    const roots = spanRecordForest(Object.freeze(records), []);
    const walk = (nodes: SpanRecordNode[], depth: number): number => {
      expect(depth).toBeLessThanOrEqual(maximumRecordDepth);
      return nodes.reduce(
        (count, node) => count + 1 + (node.children.length ? walk(node.children, depth + 1) : 0),
        0,
      );
    };
    expect(walk(roots, 0)).toBe(records.length);
    expect(roots.slice(1).every((node) => node.note?.includes("깊어"))).toBe(true);
  });
});
