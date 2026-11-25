import { CircleAlert, Flag, Gauge, GitBranch, Percent, Play, Sparkles, TriangleAlert } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import type { DynamicRouteElementType, DynamicRouteGraph } from "@/shared/api/domains/routing-dynamic";
import { cn } from "@/shared/utils/cn";

import {
  describeElement,
  edgeKey,
  elementTitle,
  elementTypeLabels,
  layoutGraph,
  outcomeLabel,
  outputLabel,
  type PathHighlight,
} from "./dynamic-route-model";

const nodeWidth = 200;
const nodeHeight = 92;
const columnGap = 64;
const rowGap = 44;
const padding = 18;
const minimumScale = 0.6;

const icons: Readonly<Record<DynamicRouteElementType, React.ReactNode>> = {
  start: <Play aria-hidden="true" />,
  conditional: <GitBranch aria-hidden="true" />,
  percentage: <Percent aria-hidden="true" />,
  rate: <Gauge aria-hidden="true" />,
  model: <Sparkles aria-hidden="true" />,
  end: <Flag aria-hidden="true" />,
};

export interface FlowIssueMarks {
  errors: ReadonlySet<string>;
  warnings: ReadonlySet<string>;
}

interface DynamicRouteFlowProps {
  graph: DynamicRouteGraph;
  label: string;
  selectedId?: string;
  onSelect?: (id: string) => void;
  highlight?: PathHighlight;
  issues?: FlowIssueMarks;
}

interface Point {
  x: number;
  y: number;
}

/**
 * The connector between two elements. Neighbours in one row get a plain curve;
 * anything else leaves the source, runs along the gap between rows and enters the
 * target, so it never passes behind an element it does not touch.
 */
function edgePath(from: Point, to: Point, sourceRow: number, targetRow: number): { d: string; label: Point } {
  const x1 = from.x + nodeWidth;
  const y1 = from.y + nodeHeight / 2;
  const x2 = to.x;
  const y2 = to.y + nodeHeight / 2;
  const adjacent = x2 - x1 <= columnGap + 1 && x2 > x1;
  if (adjacent && sourceRow === targetRow) {
    return { d: `M ${x1} ${y1} L ${x2} ${y2}`, label: { x: (x1 + x2) / 2, y: y1 - 6 } };
  }
  if (adjacent) {
    const bend = (x2 - x1) / 2;
    return {
      d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
      label: { x: x1 + 18, y: y1 - 6 },
    };
  }
  // The lane is the gap on the side of the source row facing the target; a
  // connector within one row (or pointing backwards) runs below its row.
  const lane = targetRow < sourceRow ? from.y - rowGap / 2 : from.y + nodeHeight + rowGap / 2;
  const out = x1 + 16;
  const into = x2 - 16;
  const r = 8;
  const down = lane > y1 ? 1 : -1;
  const up = y2 > lane ? 1 : -1;
  const forward = into >= out ? 1 : -1;
  const d = [
    `M ${x1} ${y1}`,
    `L ${out - r} ${y1}`,
    `Q ${out} ${y1} ${out} ${y1 + down * r}`,
    `L ${out} ${lane - down * r}`,
    `Q ${out} ${lane} ${out + forward * r} ${lane}`,
    `L ${into - forward * r} ${lane}`,
    `Q ${into} ${lane} ${into} ${lane + up * r}`,
    `L ${into} ${y2 - up * r}`,
    `Q ${into} ${y2} ${into + r} ${y2}`,
    `L ${x2} ${y2}`,
  ].join(" ");
  return { d, label: { x: out + forward * 30, y: lane - 5 } };
}

/**
 * The route as a left-to-right flow, scaled to fit its frame (down to 60%, then
 * it scrolls). Each element is a button (when selectable) whose accessible name
 * carries its outputs, so the graph reads in order without the drawing.
 */
export function DynamicRouteFlow({
  graph,
  label,
  selectedId,
  onSelect,
  highlight,
  issues,
}: DynamicRouteFlowProps): React.JSX.Element {
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const frameRef = useRef<HTMLDivElement>(null);
  const [frameWidth, setFrameWidth] = useState(0);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = (): void => setFrameWidth(frame.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  const width = padding * 2 + layout.columns * nodeWidth + (layout.columns - 1) * columnGap;
  const height = padding * 2 + layout.rows * nodeHeight + (layout.rows - 1) * rowGap + rowGap / 2;
  const scale = frameWidth > 0 ? Math.min(1, Math.max(minimumScale, (frameWidth - 2) / width)) : 1;
  const nodeById = new Map(layout.nodes.map((node) => [node.element.id, node]));
  const position = (id: string): Point | undefined => {
    const node = nodeById.get(id);
    return node
      ? { x: padding + node.column * (nodeWidth + columnGap), y: padding + node.row * (nodeHeight + rowGap) }
      : undefined;
  };
  const titles = new Map(layout.nodes.map((node) => [node.element.id, elementTitle(node.element)]));

  return (
    <div ref={frameRef} className="dr-flow-scroll" role="group" aria-label={label} tabIndex={0}>
      <div className="dr-flow-canvas" style={{ width: width * scale, height: height * scale }}>
        <div
          className="dr-flow-inner"
          style={{ width, height, transform: scale === 1 ? undefined : `scale(${scale})` }}
        >
          <svg className="dr-flow-edges" width={width} height={height} aria-hidden="true" focusable="false">
            <defs>
              <marker
                id="dr-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
            {layout.edges.map((edge) => {
              const from = position(edge.from);
              const to = position(edge.to);
              const source = nodeById.get(edge.from);
              const target = nodeById.get(edge.to);
              if (!from || !to || !source || !target) return null;
              const { d, label: anchor } = edgePath(from, to, source.row, target.row);
              const active = highlight?.edges.has(edgeKey(edge.from, edge.to)) ?? false;
              const tone = edge.output === "fallback" || edge.output === "false" ? "dr-edge-alt" : "";
              return (
                <g
                  key={`${edge.from}:${edge.output}`}
                  className={cn(
                    "dr-edge",
                    tone,
                    active && "dr-edge-active",
                    highlight && !active && "dr-edge-dim",
                  )}
                >
                  <path d={d} markerEnd="url(#dr-arrow)" />
                  <text x={anchor.x} y={anchor.y} textAnchor="middle">
                    {outputLabel(source.element.type, edge.output)}
                  </text>
                </g>
              );
            })}
          </svg>
          {layout.nodes.map((node) => {
            const { element } = node;
            const point = position(element.id) ?? { x: 0, y: 0 };
            const outcome = highlight?.outcomes.get(element.id);
            const visited = highlight?.elements.has(element.id) ?? false;
            const hasError = issues?.errors.has(element.id) ?? false;
            const hasWarning = !hasError && (issues?.warnings.has(element.id) ?? false);
            const outputs = Object.entries(element.outputs ?? {})
              .map(
                ([name, target]) =>
                  `${outputLabel(element.type, name)} → ${titles.get(target.elementId) ?? target.elementId}`,
              )
              .join(", ");
            const accessibleName = [
              `${elementTypeLabels[element.type]} ${elementTitle(element)}`,
              describeElement(element),
              outputs ? `출력: ${outputs}` : "",
              outcome ? `시뮬레이션: ${outcomeLabel(outcome)}` : "",
              hasError ? "오류 있음" : hasWarning ? "경고 있음" : "",
              node.reachable ? "" : "시작에서 도달할 수 없음",
            ]
              .filter(Boolean)
              .join(". ");
            const className = cn(
              "dr-node",
              `dr-node-${element.type}`,
              selectedId === element.id && "dr-node-selected",
              !node.reachable && "dr-node-unreachable",
              visited && "dr-node-visited",
              highlight && !visited && "dr-node-dim",
              (outcome === "failed" || outcome === "skipped") && "dr-node-failed",
              outcome === "exceeded" && "dr-node-exceeded",
              hasError && "dr-node-error",
              hasWarning && "dr-node-warning",
            );
            const body = (
              <>
                <span className="dr-node-head">
                  {icons[element.type]}
                  <span className="dr-node-type">{elementTypeLabels[element.type]}</span>
                  {hasError ? <CircleAlert className="dr-node-flag" aria-hidden="true" /> : null}
                  {hasWarning ? <TriangleAlert className="dr-node-flag" aria-hidden="true" /> : null}
                  {outcome ? <span className="dr-node-outcome">{outcomeLabel(outcome)}</span> : null}
                </span>
                <span className="dr-node-title">{elementTitle(element)}</span>
                <span className="dr-node-desc">{describeElement(element)}</span>
              </>
            );
            const style = { left: point.x, top: point.y, width: nodeWidth, height: nodeHeight };
            return onSelect ? (
              <button
                key={element.id}
                type="button"
                className={className}
                style={style}
                aria-pressed={selectedId === element.id}
                aria-label={accessibleName}
                onClick={() => onSelect(element.id)}
              >
                {body}
              </button>
            ) : (
              <div
                key={element.id}
                className={className}
                style={style}
                role="img"
                aria-label={accessibleName}
              >
                {body}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
