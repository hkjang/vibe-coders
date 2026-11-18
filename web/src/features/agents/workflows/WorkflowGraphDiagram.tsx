import { useId, useRef, useState } from "react";
import type { GraphInput } from "@/shared/api/domains/workflow-graph.schemas";
import { graphEnd, graphTypeLabels, graphWhenLabels } from "./workflow-graph-model";
import { workflowGraphLayout } from "./workflow-graph-layout";
import { useWorkflowGraphView } from "./use-workflow-graph-view";
import { WorkflowGraphControls } from "./WorkflowGraphControls";
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
  const { points, width, height } = workflowGraphLayout(draft);
  const [localSelection, setLocalSelection] = useState(draft.flow.entry);
  const nodes = useRef(new Map<string, SVGGElement>());
  const controlled = onSelect && selected !== undefined;
  const candidate = controlled ? selected : localSelection;
  const active = points.has(candidate)
    ? candidate
    : points.has(draft.flow.entry)
      ? draft.flow.entry
      : (draft.steps[0]?.id ?? "");
  const [viewportRef, view] = useWorkflowGraphView(width, height, active, points.get(active));
  const choose = (id: string) => {
    if (controlled) onSelect(id);
    else setLocalSelection(id);
    view.reveal();
  };
  return (
    <div className="workflow-graph-viewer">
      <WorkflowGraphControls steps={draft.steps} selected={active} onChoose={choose} {...view} />
      <div
        ref={viewportRef}
        className="workflow-graph-diagram"
        style={{ height }}
        tabIndex={0}
        role="region"
        aria-label="워크플로 분기 연결 그림"
      >
        <svg
          width={width * view.scale}
          height={height * view.scale}
          viewBox={`0 0 ${width} ${height}`}
          style={{ width: width * view.scale, height: height * view.scale }}
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
          {draft.steps.map((step, index) => {
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
                role="button"
                tabIndex={step.id === active ? 0 : -1}
                ref={(element) => {
                  if (element) nodes.current.set(step.id, element);
                  else nodes.current.delete(step.id);
                }}
                aria-label={`${title}, ${graphTypeLabels[step.type]}${draft.flow.entry === step.id ? ", 시작" : ""}${ending ? `, ${ending} 종료` : ""}`}
                aria-pressed={step.id === active}
                className={step.id === active ? "workflow-graph-node is-selected" : "workflow-graph-node"}
                onClick={() => choose(step.id)}
                onKeyDown={(event) => {
                  const target =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? draft.steps.length - 1
                        : event.key === "ArrowUp"
                          ? Math.max(0, index - 1)
                          : event.key === "ArrowDown"
                            ? Math.min(draft.steps.length - 1, index + 1)
                            : undefined;
                  if (target !== undefined) {
                    event.preventDefault();
                    const next = draft.steps[target];
                    if (next) {
                      choose(next.id);
                      nodes.current.get(next.id)?.focus({ preventScroll: true });
                    }
                  } else if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    choose(step.id);
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
    </div>
  );
}
