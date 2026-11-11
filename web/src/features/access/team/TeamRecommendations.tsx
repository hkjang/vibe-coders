import { SectionCard } from "@/shared/components/ui/SectionCard";
import { useTeamCandidatesQuery, useTeamOnboardingQuery, useTeamSkillsQuery } from "./use-team-queries";
import { TeamTable, type TeamColumn } from "./TeamTable";
import { TeamPartial, TeamQueryPanel } from "./team-ui";
import { teamCost, teamLatency, teamNumber, teamPercent } from "./team-model";

interface Skill {
  skill_name: string;
  runs?: number;
  success_rate?: number;
  total_cost_krw?: number;
  avg_latency_ms?: number;
}
const skillColumns: TeamColumn<Skill>[] = [
  { id: "name", header: "스킬", value: (row) => row.skill_name },
  { id: "runs", header: "실행", value: (row) => row.runs, cell: (row) => teamNumber(row.runs) },
  {
    id: "success",
    header: "성공률",
    value: (row) => row.success_rate,
    cell: (row) => teamPercent(row.success_rate),
  },
  {
    id: "cost",
    header: "비용 (원)",
    value: (row) => row.total_cost_krw,
    cell: (row) => teamCost(row.total_cost_krw),
  },
  {
    id: "latency",
    header: "평균 지연 (ms)",
    value: (row) => row.avg_latency_ms,
    cell: (row) => teamLatency(row.avg_latency_ms),
  },
];
export function TeamRecommendations() {
  const skills = useTeamSkillsQuery(),
    onboarding = useTeamOnboardingQuery(),
    candidates = useTeamCandidatesQuery();
  const starter = onboarding.data;
  const failed = starter?.partial_failures ?? [];
  return (
    <>
      <SectionCard title="팀 인기 스킬" description="선택 기간의 실행 수 기준 상위 10개 스킬입니다.">
        <TeamQueryPanel query={skills} label="팀 인기 스킬">
          <TeamTable
            id="skills"
            caption="팀 인기 스킬"
            rows={skills.data?.skills ?? []}
            columns={skillColumns}
          />
        </TeamQueryPanel>
      </SectionCard>
      <SectionCard
        title="팀 시작 안내"
        description="최근 90일의 사용 기록에서 모델·스킬·MCP 도구를 각각 최대 5개 추천합니다."
      >
        <TeamQueryPanel query={onboarding} label="팀 시작 안내">
          <TeamPartial failed={failed.length > 0} retry={onboarding.refetch} />
          <div className="access-stack">
            {!failed.includes("models") ? (
              <>
                <h3>추천 모델</h3>
                <TeamTable
                  id="starter_models"
                  caption="추천 모델"
                  rows={starter?.recommended_models ?? []}
                  columns={[
                    { id: "name", header: "모델", value: (row) => row.model },
                    {
                      id: "requests",
                      header: "요청",
                      value: (row) => row.requests,
                      cell: (row) => teamNumber(row.requests),
                    },
                    {
                      id: "cost",
                      header: "비용 (원)",
                      value: (row) => row.cost_krw,
                      cell: (row) => teamCost(row.cost_krw),
                    },
                  ]}
                />
              </>
            ) : null}
            {!failed.includes("skills") ? (
              <>
                <h3>추천 스킬</h3>
                <TeamTable
                  id="starter_skills"
                  caption="추천 스킬"
                  rows={starter?.recommended_skills ?? []}
                  columns={skillColumns}
                />
              </>
            ) : null}
            {!failed.includes("mcp") ? (
              <>
                <h3>추천 MCP 도구</h3>
                <TeamTable
                  id="tools"
                  caption="추천 MCP 도구"
                  rows={starter?.recommended_mcp ?? []}
                  columns={[
                    { id: "server", header: "서버", value: (row) => row.server_label },
                    { id: "tool", header: "도구", value: (row) => row.tool_name },
                    {
                      id: "calls",
                      header: "호출",
                      value: (row) => row.calls,
                      cell: (row) => teamNumber(row.calls),
                    },
                    {
                      id: "success",
                      header: "성공률",
                      value: (row) => row.success_rate,
                      cell: (row) => teamPercent(row.success_rate),
                    },
                    {
                      id: "latency",
                      header: "평균 지연 (ms)",
                      value: (row) => row.avg_latency_ms,
                      cell: (row) => teamLatency(row.avg_latency_ms),
                    },
                  ]}
                />
              </>
            ) : null}
          </div>
        </TeamQueryPanel>
      </SectionCard>
      <SectionCard
        title="추천 템플릿 후보"
        description="선택 기간에 같은 형태의 요청이 3회 이상 반복된 후보 최대 15개입니다."
      >
        <TeamQueryPanel query={candidates} label="템플릿 후보">
          <TeamTable
            id="candidates"
            caption="추천 템플릿 후보"
            rows={candidates.data?.candidates ?? []}
            columns={[
              { id: "fingerprint", header: "패턴 ID", value: (row) => row.fingerprint },
              { id: "task", header: "작업 유형", value: (row) => row.task_type },
              {
                id: "requests",
                header: "요청",
                value: (row) => row.requests,
                cell: (row) => teamNumber(row.requests),
              },
              {
                id: "cost",
                header: "평균 비용 (원)",
                value: (row) => row.avg_cost_krw,
                cell: (row) => teamCost(row.avg_cost_krw),
              },
              {
                id: "success",
                header: "성공률",
                value: (row) => row.success_rate,
                cell: (row) => teamPercent(row.success_rate),
              },
              {
                id: "product",
                header: "제품 등록",
                value: (row) =>
                  row.already_product === undefined ? "미확인" : row.already_product ? "등록됨" : "미등록",
              },
            ]}
          />
        </TeamQueryPanel>
      </SectionCard>
    </>
  );
}
