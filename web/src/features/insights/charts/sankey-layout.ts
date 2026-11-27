import { round2 } from "./scale";

// Pure geometry for a column Sankey diagram (조직 → 업무 → 모델): no React, no DOM.

export interface SankeyNodeInput {
  id: string;
  kind: string;
  name: string;
  value: number;
}

export interface SankeyLinkInput {
  source: string;
  target: string;
  value: number;
}

export interface SankeyNode extends SankeyNodeInput {
  column: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** What the node's height stands for: the larger of what flows in and out. */
  throughput: number;
}

export interface SankeyLink extends SankeyLinkInput {
  /** Closed ribbon from the source's right edge to the target's left edge. */
  path: string;
  thickness: number;
  sourceY: number;
  targetY: number;
}

export interface SankeyFrame {
  width: number;
  height: number;
  padding: { top: number; right: number; bottom: number; left: number };
  nodeWidth: number;
  nodeGap: number;
  /** Node kinds, left to right. Nodes of any other kind are ignored. */
  columns: readonly string[];
}

export interface SankeyLayout {
  nodes: SankeyNode[];
  links: SankeyLink[];
  /** User units per unit of value. */
  scale: number;
}

const positive = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

/**
 * Lays nodes out in one column per kind, tallest first, and draws each link as a
 * ribbon whose thickness is its value on the same scale as the node heights.
 * Links that point at a missing node, backwards or within a column are dropped.
 */
export function sankeyLayout(
  nodeInputs: readonly SankeyNodeInput[],
  linkInputs: readonly SankeyLinkInput[],
  frame: SankeyFrame,
): SankeyLayout {
  const columnOf = new Map<string, number>();
  const known = new Map<string, SankeyNodeInput>();
  for (const node of nodeInputs) {
    const column = frame.columns.indexOf(node.kind);
    if (column < 0 || known.has(node.id)) continue;
    known.set(node.id, node);
    columnOf.set(node.id, column);
  }
  const links = linkInputs.filter((link) => {
    const from = columnOf.get(link.source);
    const to = columnOf.get(link.target);
    return from !== undefined && to !== undefined && from < to && positive(link.value) > 0;
  });

  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const link of links) {
    outgoing.set(link.source, (outgoing.get(link.source) ?? 0) + link.value);
    incoming.set(link.target, (incoming.get(link.target) ?? 0) + link.value);
  }
  const throughput = (node: SankeyNodeInput): number => {
    const flow = Math.max(incoming.get(node.id) ?? 0, outgoing.get(node.id) ?? 0);
    return flow > 0 ? flow : positive(node.value);
  };

  const columns = frame.columns.map((_, column) =>
    [...known.values()]
      .filter((node) => columnOf.get(node.id) === column && throughput(node) > 0)
      .sort((left, right) => throughput(right) - throughput(left)),
  );
  const plotHeight = frame.height - frame.padding.top - frame.padding.bottom;
  const plotWidth = frame.width - frame.padding.left - frame.padding.right;
  // One scale for the whole diagram, set by the column that needs the most room.
  let scale = Number.POSITIVE_INFINITY;
  for (const column of columns) {
    if (column.length === 0) continue;
    const total = column.reduce((sum, node) => sum + throughput(node), 0);
    const room = plotHeight - frame.nodeGap * (column.length - 1);
    scale = Math.min(scale, room > 0 && total > 0 ? room / total : 0);
  }
  if (!Number.isFinite(scale)) scale = 0;

  const span = frame.columns.length > 1 ? (plotWidth - frame.nodeWidth) / (frame.columns.length - 1) : 0;
  const placed = new Map<string, SankeyNode>();
  const nodes: SankeyNode[] = [];
  columns.forEach((column, index) => {
    let y = frame.padding.top;
    for (const node of column) {
      const flow = throughput(node);
      const item: SankeyNode = {
        ...node,
        column: index,
        x: frame.padding.left + index * span,
        y,
        width: frame.nodeWidth,
        height: flow * scale,
        throughput: flow,
      };
      placed.set(node.id, item);
      nodes.push(item);
      y += item.height + frame.nodeGap;
    }
  });

  // Ribbons leave and enter a node in the vertical order of their other end, so they do not cross needlessly.
  const sourceOffset = new Map<string, number>();
  const targetOffset = new Map<string, number>();
  const sourceY = new Map<SankeyLinkInput, number>();
  const targetY = new Map<SankeyLinkInput, number>();
  const usable = links.filter((link) => placed.has(link.source) && placed.has(link.target));
  const nodeY = (id: string): number => placed.get(id)?.y ?? 0;
  for (const link of [...usable].sort(
    (left, right) => nodeY(left.target) - nodeY(right.target) || nodeY(left.source) - nodeY(right.source),
  )) {
    const offset = sourceOffset.get(link.source) ?? 0;
    sourceY.set(link, nodeY(link.source) + offset);
    sourceOffset.set(link.source, offset + link.value * scale);
  }
  for (const link of [...usable].sort(
    (left, right) => nodeY(left.source) - nodeY(right.source) || nodeY(left.target) - nodeY(right.target),
  )) {
    const offset = targetOffset.get(link.target) ?? 0;
    targetY.set(link, nodeY(link.target) + offset);
    targetOffset.set(link.target, offset + link.value * scale);
  }

  return {
    scale,
    nodes,
    links: usable.map((link) => {
      const source = placed.get(link.source) as SankeyNode;
      const target = placed.get(link.target) as SankeyNode;
      const thickness = link.value * scale;
      const y0 = sourceY.get(link) ?? source.y;
      const y1 = targetY.get(link) ?? target.y;
      const x0 = source.x + source.width;
      const x1 = target.x;
      const middle = (x0 + x1) / 2;
      const path = [
        `M${round2(x0)} ${round2(y0)}`,
        `C${round2(middle)} ${round2(y0)} ${round2(middle)} ${round2(y1)} ${round2(x1)} ${round2(y1)}`,
        `L${round2(x1)} ${round2(y1 + thickness)}`,
        `C${round2(middle)} ${round2(y1 + thickness)} ${round2(middle)} ${round2(y0 + thickness)} ${round2(x0)} ${round2(y0 + thickness)}`,
        "Z",
      ].join(" ");
      return { ...link, path, thickness, sourceY: y0, targetY: y1 };
    }),
  };
}
