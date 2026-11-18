import type { Workflow } from "@/shared/api/domains/agents.schemas";
import { workflowGraphInputSchema } from "@/shared/api/domains/workflow-graph.schemas";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { WorkflowGraphDiagram } from "./WorkflowGraphDiagram";
import { graphEnd, graphIssues, graphWhenLabels } from "./workflow-graph-model";
import { flowDisplay } from "./workflow-flow";

export function WorkflowGraphRead({
  workflow,
  prefixes,
}: {
  workflow: Workflow;
  prefixes: readonly string[];
}) {
  const result = workflowGraphInputSchema.safeParse(workflow);
  if (!result.success)
    return (
      <InlineNotice tone="warning">
        이 버전에서 분기 정의를 표시할 수 없습니다. 정의와 서버 버전을 확인하세요.
      </InlineNotice>
    );
  const value = result.data;
  const safe = {
    ...value,
    steps: value.steps.map((step) => ({ ...step, name: flowDisplay(step.name, prefixes) })),
  };
  const name = (id: string) =>
    id === graphEnd ? "종료" : safe.steps.find((step) => step.id === id)?.name || "대상 없음";
  const issues = graphIssues(value);
  return (
    <div className="workflow-graph-editor">
      <p>
        저장된 분기 연결입니다. 시작: {name(value.flow.entry)}. 실제 선택 경로는 실행 영수증에서 확인하세요.
      </p>
      {issues.length ? (
        <InlineNotice tone="warning">현재 연결을 확인해야 합니다. 분기 편집기에서 검증하세요.</InlineNotice>
      ) : null}
      <WorkflowGraphDiagram draft={safe} />
      <div className="data-table-scroll" tabIndex={0} role="region" aria-label="분기 연결 표">
        <table className="data-table">
          <caption>단계 연결</caption>
          <thead>
            <tr>
              <th scope="col">출발 단계</th>
              <th scope="col">조건</th>
              <th scope="col">다음 단계</th>
            </tr>
          </thead>
          <tbody>
            {value.flow.edges.map((edge, index) => (
              <tr key={index}>
                <td>{name(edge.from)}</td>
                <td>{graphWhenLabels[edge.when]}</td>
                <td>{name(edge.to)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
