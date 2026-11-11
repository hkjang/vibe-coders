import { httpTone } from "@/features/access/access-format";
import { Badge } from "@/shared/components/ui/Badge";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { formatDateTime } from "@/shared/utils/format";
import { useTeamDashboardQuery } from "./use-team-queries";
import { teamNumber, teamCost, teamLatency, teamPercent } from "./team-model";
import { TeamTable } from "./TeamTable";
import { TeamQueryPanel } from "./team-ui";
import { TeamOperationsCards } from "./TeamOperationsCards";
import { TeamRecommendations } from "./TeamRecommendations";
import { TeamReports } from "./TeamReports";

export function TeamDashboardTab() {
  const query = useTeamDashboardQuery();
  const board = query.data?.dashboard;
  const totals = board?.totals;
  return (
    <div className="access-stack">
      <TeamQueryPanel query={query} label="팀 사용량">
        <StatGrid label="팀 사용 요약">
          <StatCard label="요청" value={teamNumber(totals?.requests)} />
          <StatCard label="성공률" value={teamPercent(totals?.success_rate)} />
          <StatCard
            label="오류"
            tone={(totals?.errors ?? 0) > 0 ? "warning" : "default"}
            value={teamNumber(totals?.errors)}
          />
          <StatCard label="비용" value={teamCost(totals?.cost_krw)} />
          <StatCard label="평균 지연" value={teamLatency(totals?.avg_latency_ms)} />
          <StatCard
            label="팀 집계 식별자"
            value={teamNumber(board?.team_keys.length)}
            hint="팀 ID와 이름 등 사용량을 묶는 식별자 수입니다."
          />
        </StatGrid>
        <SectionCard title="팀원 사용량" description="요청 수 기준 상위 10명의 사용량입니다.">
          <TeamTable
            id="users"
            caption="팀원 사용량"
            rows={board?.top_users ?? []}
            columns={[
              { id: "user", header: "사용자 ID", value: (row) => row.user_id },
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
              {
                id: "errors",
                header: "오류",
                value: (row) => row.errors,
                cell: (row) => teamNumber(row.errors),
              },
            ]}
          />
        </SectionCard>
        <SectionCard title="팀 모델 사용" description="요청 수 기준 상위 10개 모델입니다.">
          <TeamTable
            id="models"
            caption="팀 모델 사용"
            rows={board?.models ?? []}
            columns={[
              { id: "model", header: "모델", value: (row) => row.model },
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
        </SectionCard>
        <SectionCard title="팀 최근 실패" description="선택 기간의 최근 실패 최대 10건입니다.">
          <TeamTable
            id="failures"
            caption="팀 최근 실패"
            rows={board?.recent_failures ?? []}
            columns={[
              { id: "id", header: "요청 ID", value: (row) => row.id },
              { id: "model", header: "모델", value: (row) => row.model },
              {
                id: "status",
                header: "HTTP 상태",
                value: (row) => row.status_code,
                cell: (row) => (
                  <Badge tone={httpTone(row.status_code ?? 0)}>{row.status_code ?? "미확인"}</Badge>
                ),
              },
              { id: "error", header: "오류", value: (row) => row.error },
              {
                id: "created",
                header: "발생 시각",
                value: (row) => row.created_at,
                cell: (row) => formatDateTime(row.created_at),
              },
            ]}
          />
        </SectionCard>
      </TeamQueryPanel>
      <TeamOperationsCards />
      <TeamReports />
      <TeamRecommendations />
    </div>
  );
}
