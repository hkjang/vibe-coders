import { useId } from "react";
import type { GraphInput } from "@/shared/api/domains/workflow-graph.schemas";
import { graphEnd, graphTypeLabels, graphWhenLabels } from "./workflow-graph-model";
import "./workflow-graph.css";

export function WorkflowGraphDiagram({
  draft,
  selected,
  onSelect,
}: {
  draft: GraphInput;
  selected?: string;
  onSelect?: (id: string) => void;
}) {
  const marker = useId().replaceAll(":", "");
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
  return (
    <div className="workflow-graph-diagram" tabIndex={0} role="region" aria-label="워크플로 분기 연결 그림">
      <svg
        width={width}
        height={height}
        style={{ width, height }}
        aria-label={
          onSelect ? "단계를 선택하면 아래에서 편집할 수 있습니다." : "현재 정의의 단계와 분기 연결"
        }
      >
        <defs>
          <marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0 0 L8 4 L0 8Z" className="workflow-graph-arrow" />
          </marker>
        </defs>
        {draft.flow.edges.map((edge, index) => {
          const a = points.get(edge.from),
            b = points.get(edge.to);
          if (!a || !b) return null;
          const y = a.y + (edge.when === "true" ? 24 : edge.when === "false" ? 48 : 36);
          return (
            <g key={index} className="workflow-graph-edge">
              <path
                d={`M${a.x + 188},${y} C${a.x + 214},${y} ${b.x - 26},${b.y + 36} ${b.x - 4},${b.y + 36}`}
                markerEnd={`url(#${marker})`}
              />
              <text x={a.x + 192} y={y - 6}>
                {graphWhenLabels[edge.when]}
              </text>
            </g>
          );
        })}
        {draft.steps.map((step) => {
          const point = points.get(step.id);
          if (!point) return null;
          const title = step.name || step.id;
          const ending = draft.flow.edges
            .filter((edge) => edge.from === step.id && edge.to === graphEnd)
            .map((edge) => graphWhenLabels[edge.when])
            .join("·");
          return (
            <g
              key={step.id}
              transform={`translate(${point.x} ${point.y})`}
              role={onSelect ? "button" : "img"}
              tabIndex={onSelect ? 0 : undefined}
              aria-label={`${title}, ${graphTypeLabels[step.type]}${draft.flow.entry === step.id ? ", 시작" : ""}${ending ? `, ${ending} 종료` : ""}`}
              aria-pressed={onSelect ? step.id === selected : undefined}
              className={step.id === selected ? "workflow-graph-node is-selected" : "workflow-graph-node"}
              onClick={() => onSelect?.(step.id)}
              onKeyDown={(event) => {
                if (onSelect && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault();
                  onSelect(step.id);
                }
              }}
            >
              <title>{title}</title>
              <rect width="188" height="72" rx="8" />
              <text x="12" y="23" className="workflow-graph-kind">
                {draft.flow.entry === step.id ? "시작 · " : ""}
                {graphTypeLabels[step.type]}
              </text>
              <text x="12" y="46">
                {[...title].slice(0, 14).join("")}
                {[...title].length > 14 ? "…" : ""}
              </text>
              {ending ? (
                <text x="12" y="94" className="workflow-graph-ending">
                  {ending} → 종료
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
