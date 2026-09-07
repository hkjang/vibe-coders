import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { PanelFailure, ScoreBars } from "@/features/governance/reports/report-parts";
import { gradeTone, scoreCell, type ReportWindow } from "@/features/governance/reports/report-window";
import { downloadExport, exportDateStamp } from "@/features/governance/reports/report-download";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import type { TeamScorecardRow } from "@/shared/api/domains/governance-reports";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime, formatKRW, formatNumber } from "@/shared/utils/format";

function scorecardColumns(): ReadonlyArray<DataTableColumn<TeamScorecardRow>> {
  const column = createDataTableColumnHelper<TeamScorecardRow>();
  return column.columns([
    column.accessor((row) => row.team, { id: "team", header: "팀" }),
    column.accessor((row) => row.overall, {
      id: "overall",
      header: "종합",
      cell: ({ row }) => (
        <span className="badge-list">
          <Badge tone={gradeTone(row.original.grade)}>{row.original.grade}</Badge>{" "}
          <strong>{formatNumber(Math.round(row.original.overall))}</strong>
        </span>
      ),
    }),
    column.accessor((row) => row.requests, {
      id: "requests",
      header: "요청",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.requests)}</span>,
    }),
    column.accessor((row) => row.cost_krw, {
      id: "cost",
      header: "비용",
      cell: ({ row }) => <span className="cell-number">{formatKRW(row.original.cost_krw)}</span>,
    }),
    column.accessor((row) => row.cost_efficiency, {
      id: "cost_efficiency",
      header: "비용효율",
      cell: ({ row }) => <span className="cell-number">{scoreCell(row.original.cost_efficiency)}</span>,
    }),
    column.accessor((row) => row.success_rate, {
      id: "success_rate",
      header: "성공률",
      cell: ({ row }) => <span className="cell-number">{scoreCell(row.original.success_rate)}</span>,
    }),
    column.accessor((row) => row.cache_rate, {
      id: "cache_rate",
      header: "캐시율",
      cell: ({ row }) => <span className="cell-number">{scoreCell(row.original.cache_rate)}</span>,
    }),
    column.accessor((row) => row.skill_reuse, {
      id: "skill_reuse",
      header: "Skill 재사용",
      cell: ({ row }) => <span className="cell-number">{scoreCell(row.original.skill_reuse)}</span>,
    }),
    column.accessor((row) => row.mcp_success, {
      id: "mcp_success",
      header: "MCP 성공",
      cell: ({ row }) => <span className="cell-number">{scoreCell(row.original.mcp_success)}</span>,
    }),
    column.accessor((row) => row.text2sql_success, {
      id: "text2sql_success",
      header: "Text2SQL",
      cell: ({ row }) => <span className="cell-number">{scoreCell(row.original.text2sql_success)}</span>,
    }),
    column.accessor((row) => row.policy_compliance, {
      id: "policy_compliance",
      header: "정책 준수",
      cell: ({ row }) => <span className="cell-number">{scoreCell(row.original.policy_compliance)}</span>,
    }),
    column.accessor((row) => row.satisfaction, {
      id: "satisfaction",
      header: "만족도",
      cell: ({ row }) => <span className="cell-number">{scoreCell(row.original.satisfaction)}</span>,
    }),
  ]);
}

export function ScorecardTab({
  canExport,
  refetchInterval,
  window: reportWindow,
}: {
  canExport: boolean;
  refetchInterval: number | false;
  window: ReportWindow;
}): React.JSX.Element {
  const columns = useMemo(() => scorecardColumns(), []);
  const [exporting, setExporting] = useState(false);
  const scorecard = useQuery({
    queryKey: ["governance", "scorecard", reportWindow],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.governanceReports.teamScorecard, {
        query: { window: reportWindow },
        signal,
        routeId: "governance.reports",
      }),
    refetchInterval,
    refetchIntervalInBackground: false,
  });

  const teams = scorecard.data?.teams ?? [];
  const graded = teams.filter((team) => team.grade !== "N/A");
  const averageOverall = graded.length
    ? graded.reduce((sum, team) => sum + team.overall, 0) / graded.length
    : 0;
  const totalCost = teams.reduce((sum, team) => sum + team.cost_krw, 0);
  const topTeams = [...teams]
    .sort((left, right) => right.overall - left.overall)
    .slice(0, 8)
    .map((team) => ({
      label: `${team.team} (${team.grade})`,
      value: team.overall,
      display: `${formatNumber(Math.round(team.overall))}점`,
    }));

  const exportCsv = async (): Promise<void> => {
    setExporting(true);
    try {
      await downloadExport(
        `/admin/teams/scorecard?window=${encodeURIComponent(reportWindow)}&format=csv`,
        `team-scorecard-${exportDateStamp()}.csv`,
      );
      toast.success("팀 성숙도 CSV를 내려받았습니다.");
    } catch (error) {
      toast.error(safeAppErrorMessage(error, "CSV를 내려받지 못했습니다."));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="gov-stack">
      {scorecard.isError ? (
        <PanelFailure error={scorecard.error} label="팀 성숙도" onRetry={() => void scorecard.refetch()} />
      ) : null}
      <StatGrid label="팀 성숙도 요약">
        <StatCard label="평가 팀" value={formatNumber(teams.length)} />
        <StatCard
          label="평균 종합 점수"
          value={graded.length ? formatNumber(Math.round(averageOverall)) : "—"}
          hint="데이터가 없는 항목은 평균에서 제외됩니다."
        />
        <StatCard
          label="A 등급 팀"
          tone={teams.some((team) => team.grade === "A") ? "success" : "default"}
          value={formatNumber(teams.filter((team) => team.grade === "A").length)}
        />
        <StatCard
          label="D 등급 팀"
          tone={teams.some((team) => team.grade === "D") ? "danger" : "default"}
          value={formatNumber(teams.filter((team) => team.grade === "D").length)}
        />
        <StatCard label="기간 총 비용" value={formatKRW(totalCost)} />
      </StatGrid>

      <SectionCard
        headingLevel={2}
        title="팀별 AI 성숙도 점수"
        description="0~100점이며 “—”는 해당 지표의 데이터가 없다는 뜻입니다."
        actions={
          <Button
            onClick={() => void exportCsv()}
            disabled={!canExport || exporting}
            title={canExport ? undefined : "CSV를 내려받으려면 admin:read 권한이 필요합니다."}
          >
            <Download aria-hidden="true" /> CSV 다운로드
          </Button>
        }
      >
        {topTeams.length > 0 ? <ScoreBars data={topTeams} max={100} /> : null}
        <DataTable
          caption="팀 성숙도 스코어카드"
          columns={columns}
          data={teams}
          getRowId={(row, index) => row.team || `team-${index}`}
          loading={scorecard.isPending}
          error={
            scorecard.isError
              ? safeAppErrorMessage(scorecard.error, "팀 성숙도를 불러오지 못했습니다.")
              : undefined
          }
          onRetry={() => void scorecard.refetch()}
          emptyMessage="표시할 팀 데이터가 없습니다."
        />
        {!scorecard.isPending && !scorecard.isError && teams.length === 0 ? (
          <EmptyState
            title="아직 점수를 매길 팀이 없습니다."
            description="팀에 API 키를 배정하고 호출이 기록되면 팀별 성숙도 점수가 계산됩니다."
          />
        ) : null}
        {scorecard.data?.note ? <p className="gov-note">{scorecard.data.note}</p> : null}
        {scorecard.data?.generated_at ? (
          <p className="gov-note updated-at">생성 시각: {formatDateTime(scorecard.data.generated_at)}</p>
        ) : null}
      </SectionCard>
    </div>
  );
}
