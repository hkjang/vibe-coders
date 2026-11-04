import { useId, useMemo } from "react";
import type { McpTopology, McpTopologyNode } from "@/shared/api/domains/mcp.schemas";
import { graphLimit, layoutTopology, topologyKind, topologyState } from "./mcp-topology-model";

export function TopologyGraph({
  nodes,
  edges,
  selected,
  onSelect,
}: {
  nodes: McpTopologyNode[];
  edges: McpTopology["edges"];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const id = useId();
  const { positions, width, height } = useMemo(() => layoutTopology(nodes), [nodes]);
  const byId = new Map(positions.map((position) => [position.node.id, position]));
  return (
    <>
      <p id={id}>
        화살표는 서버가 반환한 연결 방향입니다. 노드를 선택하면 정확한 연결 목록을 확인합니다. 연결도는 필터
        결과 중 최대 {graphLimit}개를 표시하며 전체 결과는 목록에서 확인하세요.
      </p>
      <div
        className="mcp-topology-scroll"
        role="region"
        aria-label="MCP 연결도"
        aria-describedby={id}
        tabIndex={0}
      >
        <div className="mcp-topology-canvas" style={{ width, height }}>
          <svg width={width} height={height} aria-hidden="true" focusable="false">
            <defs>
              <marker
                id={`${id}-arrow`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
            {edges.map((edge, index) => {
              const from = byId.get(edge.from),
                to = byId.get(edge.to);
              if (!from || !to) return null;
              const active = edge.from === selected || edge.to === selected;
              return (
                <path
                  key={index}
                  className={active ? "is-selected" : undefined}
                  markerEnd={`url(#${id}-arrow)`}
                  d={`M ${from.x + 210} ${from.y + 46} C ${from.x + 232} ${from.y + 46}, ${to.x - 22} ${to.y + 46}, ${to.x} ${to.y + 46}`}
                />
              );
            })}
          </svg>
          {positions.map(({ node, x, y }) => (
            <button
              key={node.id}
              type="button"
              className="mcp-topology-node"
              style={{ left: x, top: y }}
              aria-pressed={selected === node.id}
              aria-label={`${node.label || node.id} 연결 상세`}
              title={node.label || node.id}
              onClick={() => onSelect(node.id)}
            >
              <span>{topologyKind(node.kind)}</span>
              <strong>{node.label || node.id}</strong>
              <span>{topologyState(node.decision || node.status)}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
