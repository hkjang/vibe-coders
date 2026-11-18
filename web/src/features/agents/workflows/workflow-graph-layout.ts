import type { GraphInput } from "@/shared/api/domains/workflow-graph.schemas";
import { graphEnd } from "./workflow-graph-model";

export function workflowGraphLayout(draft: GraphInput) {
  const depth = new Map<string, number>([[draft.flow.entry, 0]]);
  // Bounded relaxation keeps the drawing available while the user fixes a
  // temporary cycle. Structural validation, not layout, decides saveability.
  for (let pass = 0; pass < draft.steps.length; pass++) {
    let changed = false;
    for (const edge of draft.flow.edges) {
      const from = depth.get(edge.from);
      if (from !== undefined && edge.to !== graphEnd && !depth.has(edge.to)) {
        depth.set(edge.to, from + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const rows = new Map<number, number>();
  const points = new Map<string, { x: number; y: number }>();
  for (const step of draft.steps) {
    const column = depth.get(step.id) ?? 0;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    points.set(step.id, { x: 24 + column * 264, y: 28 + row * 116 });
  }
  const width = Math.max(260, ...[...points.values()].map((point) => point.x + 216));
  const height = Math.max(150, ...[...points.values()].map((point) => point.y + 110));
  return { points, width, height };
}
