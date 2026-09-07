import type { SkillGraphEdge, SkillGraphNode, SkillGraphSkill } from "@/shared/api/domains/agents.schemas";
import { Badge } from "@/shared/components/ui/Badge";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { riskTone, skillRiskLabels } from "@/features/agents/skills/skill-form";

const rowHeight = 26;
const leftX = 16;
const rightX = 340;
const nodeWidth = 200;
const nodeHeight = 20;
const svgWidth = 560;

const typeLabels: Record<string, string> = {
  skill: "Skill",
  model: "모델",
  tool: "도구",
  team: "팀",
  policy: "정책",
};

interface SkillGraphViewProps {
  edges: readonly SkillGraphEdge[];
  nodes: readonly SkillGraphNode[];
  skills: readonly SkillGraphSkill[];
}

/**
 * Dependency graph drawn as inline SVG (no charting library). The SVG is a
 * summary picture; the hierarchical list below carries the same data for
 * keyboard and screen-reader users.
 */
export function SkillGraphView({ edges, nodes, skills }: SkillGraphViewProps): React.JSX.Element {
  if (nodes.length === 0) {
    return (
      <EmptyState
        title="프로덕션 Skill 의존성이 없습니다."
        description="Skill을 프로덕션으로 승격하면 모델·도구·팀 의존성이 여기에 나타납니다."
      />
    );
  }

  const skillNodes = nodes.filter((node) => node.type === "skill");
  const otherNodes = nodes.filter((node) => node.type !== "skill");
  const positions = new Map<string, { x: number; y: number }>();
  skillNodes.forEach((node, index) => {
    positions.set(node.id, { x: leftX, y: 20 + index * rowHeight });
  });
  otherNodes.forEach((node, index) => {
    positions.set(node.id, { x: rightX, y: 20 + index * rowHeight });
  });
  const height = 40 + Math.max(skillNodes.length, otherNodes.length) * rowHeight;

  return (
    <>
      <div className="agents-graph">
        <svg
          width={svgWidth}
          height={height}
          viewBox={`0 0 ${svgWidth} ${height}`}
          role="img"
          aria-label={`Skill 의존성 그래프: Skill ${skillNodes.length}개와 의존 대상 ${otherNodes.length}개, 연결 ${edges.length}개`}
        >
          {edges.map((edge, index) => {
            const from = positions.get(edge.from ?? "");
            const to = positions.get(edge.to ?? "");
            if (!from || !to) return null;
            const fromRight = from.x < to.x;
            return (
              <line
                key={`${edge.from ?? ""}-${edge.to ?? ""}-${index}`}
                className="agents-graph-edge"
                x1={fromRight ? from.x + nodeWidth : from.x}
                y1={from.y + nodeHeight / 2}
                x2={fromRight ? to.x : to.x + nodeWidth}
                y2={to.y + nodeHeight / 2}
              />
            );
          })}
          {nodes.map((node) => {
            const position = positions.get(node.id);
            if (!position) return null;
            return (
              <g key={node.id}>
                <rect
                  className={`agents-graph-node-${node.type ?? "model"}`}
                  x={position.x}
                  y={position.y}
                  width={nodeWidth}
                  height={nodeHeight}
                  rx={4}
                />
                <text className="agents-graph-label" x={position.x + 8} y={position.y + 14}>
                  {(node.label ?? node.id).slice(0, 28)}
                </text>
              </g>
            );
          })}
        </svg>
        <p className="agents-graph-legend">
          {Object.entries(typeLabels).map(([type, label]) => (
            <span key={type}>
              {label} {nodes.filter((node) => (node.type ?? "") === type).length}
            </span>
          ))}
        </p>
      </div>

      <ul className="agents-tree" aria-label="Skill 의존성 상세">
        {skills.map((skill) => (
          <li key={skill.name ?? ""}>
            <h4>
              {skill.name ?? "—"}{" "}
              <Badge tone={riskTone(skill.risk_level)}>
                {skillRiskLabels[skill.risk_level ?? ""] ?? skill.risk_level ?? "—"}
              </Badge>
            </h4>
            <KeyValueList
              columns={2}
              items={[
                { label: "모델", value: (skill.models ?? []).join(", ") },
                { label: "도구", value: (skill.tools ?? []).join(", ") },
                { label: "팀", value: (skill.teams ?? []).join(", ") },
                {
                  label: "관할 정책",
                  value: (skill.governing_policies ?? [])
                    .map((policy) => `${policy.name ?? policy.id ?? ""} (${policy.via ?? ""})`)
                    .join(", "),
                },
              ]}
            />
          </li>
        ))}
      </ul>
    </>
  );
}
