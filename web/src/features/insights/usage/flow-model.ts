import { categoryPaint, restId, type CategoryPaint } from "@/features/insights/charts/palette";

// Helpers for the 조직 → 업무 → 모델 flow. Node IDs may arrive bare (`dev`) or
// prefixed with their kind (`category:dev`); both are read the same way.

export const flowColumns = [
  { kind: "team", label: "조직" },
  { kind: "category", label: "업무" },
  { kind: "model", label: "모델" },
] as const;

interface FlowNode {
  id: string;
  kind: string;
  name: string;
}

/** The identifier a filter needs: the node ID without its kind prefix, or its name. */
export function flowNodeKey(node: FlowNode): string {
  const prefix = `${node.kind}:`;
  const key = node.id.startsWith(prefix) ? node.id.slice(prefix.length) : node.id;
  return key || node.name;
}

/** Name of the node each column folds its smaller (and its too-small-to-show) entries into. */
export const flowRestName = "기타";

/** True for a column's "기타" node: it stands for many teams, categories or models, so it filters nothing. */
export function isFlowRest(node: FlowNode): boolean {
  return node.id === `${node.kind}:${flowRestName}`;
}

/** Category nodes wear their category's colour; teams, models and "기타" stay neutral. */
export function flowNodePaint(node: FlowNode): CategoryPaint {
  return node.kind === "category" && !isFlowRest(node)
    ? categoryPaint(flowNodeKey(node))
    : categoryPaint(restId);
}
