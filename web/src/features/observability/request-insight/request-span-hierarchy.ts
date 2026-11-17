import type { RequestTraceSpan } from "@/shared/api/domains/observability.schemas";
import { containsPotentialSecret } from "@/shared/security/secrets";

export const maximumRecordDepth = 4;
export interface SpanRecordNode {
  key: string;
  span: RequestTraceSpan;
  note?: string;
  children: SpanRecordNode[];
}

function usableIdentity(value: string | undefined, prefixes: readonly string[]): value is string {
  return Boolean(
    value &&
    value.length <= 512 &&
    new TextEncoder().encode(value).length <= 512 &&
    !/[\p{Cc}\p{Cs}]/u.test(value) &&
    !/\[REDACTED[^\]]*\]/iu.test(value) &&
    !containsPotentialSecret(value, prefixes),
  );
}

/** Declared relationships only. Keep every row, including malformed identities.
 * Iterative cycle/depth handling bounds nesting without a recursive data walk.
 */
export function spanRecordForest(
  spans: readonly RequestTraceSpan[],
  prefixes: readonly string[],
): SpanRecordNode[] {
  const identities = new Map<string, number>();
  spans.forEach((span, index) => {
    if (usableIdentity(span.span_id, prefixes)) {
      identities.set(span.span_id, identities.has(span.span_id) ? -1 : index);
    }
  });
  const nodes: SpanRecordNode[] = spans.map((span, index) => ({
    key: identities.get(span.span_id) === index ? `id:${span.span_id}` : `row:${index}`,
    span,
    children: [],
  }));
  const parents = nodes.map((node, index): number | undefined => {
    const { span } = node;
    if (identities.get(span.span_id) !== index) {
      node.note = "식별자를 확인할 수 없거나 중복되어 별도로 표시합니다.";
      return undefined;
    }
    if (!span.parent_span_id) return undefined;
    if (!usableIdentity(span.parent_span_id, prefixes)) {
      node.note = "상위 식별자를 확인할 수 없어 별도로 표시합니다.";
      return undefined;
    }
    const parent = identities.get(span.parent_span_id);
    if (parent === undefined || parent < 0) {
      node.note = "상위 기록이 없거나 중복되어 별도로 표시합니다.";
      return undefined;
    }
    return parent;
  });
  const visited = new Uint8Array(nodes.length);
  for (let index = 0; index < nodes.length; index++) {
    if (visited[index]) continue;
    const path: number[] = [];
    let cursor: number | undefined = index;
    while (cursor !== undefined && visited[cursor] === 0) {
      visited[cursor] = 1;
      path.push(cursor);
      cursor = parents[cursor];
    }
    if (cursor !== undefined && visited[cursor] === 1) {
      const cycleStart = path.indexOf(cursor);
      for (const cyclic of path.slice(cycleStart)) {
        parents[cyclic] = undefined;
        const node = nodes[cyclic];
        if (node) node.note = "순환 관계가 있어 별도로 표시합니다.";
      }
    }
    for (const member of path) visited[member] = 2;
  }
  const children: number[][] = nodes.map(() => []);
  const queue: { index: number; depth: number }[] = [];
  parents.forEach((parent, index) => {
    if (parent === undefined) queue.push({ index, depth: 0 });
    else children[parent]?.push(index);
  });
  for (const { index, depth } of queue) {
    for (const child of children[index] ?? []) {
      const overflow = depth === maximumRecordDepth;
      if (overflow) {
        parents[child] = undefined;
        const node = nodes[child];
        if (node) node.note = "관계가 깊어 별도 묶음으로 표시합니다. 상위 기록이 없는 것은 아닙니다.";
      }
      queue.push({ index: child, depth: overflow ? 0 : depth + 1 });
    }
  }
  const roots: SpanRecordNode[] = [];
  parents.forEach((parent, index) => {
    const node = nodes[index];
    if (!node) return;
    if (parent === undefined) roots.push(node);
    else nodes[parent]?.children.push(node);
  });
  return roots;
}
