import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";

import { PanelFailure, ScoreBars } from "@/features/governance/reports/report-parts";
import { reportWindowDays, type ReportWindow } from "@/features/governance/reports/report-window";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import type {
  BenchmarkTeamRow,
  BenchmarkUserRow,
  ProductivityRepoRow,
} from "@/shared/api/domains/governance-reports";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatKRW, formatNumber, formatPercent, shortId } from "@/shared/utils/format";

const benchmarkLimit = 50;

function repoColumns(): ReadonlyArray<DataTableColumn<ProductivityRepoRow>> {
  const column = createDataTableColumnHelper<ProductivityRepoRow>();
  return column.columns([
    column.accessor((row) => row.repo, { id: "repo", header: "repo" }),
    column.accessor((row) => row.ai_requests, {
      id: "ai_requests",
      header: "AI 요청",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.ai_requests)}</span>,
    }),
    column.accessor((row) => row.ai_cost_krw, {
      id: "ai_cost",
      header: "AI 비용",
      cell: ({ row }) => <span className="cell-number">{formatKRW(row.original.ai_cost_krw)}</span>,
    }),
    column.accessor((row) => row.commits, {
      id: "commits",
      header: "commit",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.commits)}</span>,
    }),
    column.accessor((row) => row.merge_requests, {
      id: "merge_requests",
      header: "MR",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.merge_requests)}</span>,
    }),
    column.accessor((row) => row.merged, {
      id: "merged",
      header: "머지",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.merged)}</span>,
    }),
    column.accessor((row) => row.cost_per_merged_krw, {
      id: "cost_per_merged",
      header: "머지당 비용",
      cell: ({ row }) => (
        <span className="cell-number">
          {row.original.merged > 0 ? formatKRW(row.original.cost_per_merged_krw) : "—"}
        </span>
      ),
    }),
  ]);
}

function benchmarkUserColumns(): ReadonlyArray<DataTableColumn<BenchmarkUserRow>> {
  const column = createDataTableColumnHelper<BenchmarkUserRow>();
  return column.columns([
    column.accessor((row) => row.name || row.api_key_id, {
      id: "user",
      header: "사용자 / 키",
      cell: ({ row }) => (
        <div>
          <div>{row.original.name || "(이름 없음)"}</div>
          <div className="mono truncate" title={row.original.api_key_id}>
            {shortId(row.original.api_key_id)}
          </div>
        </div>
      ),
    }),
    column.accessor((row) => row.team, { id: "team", header: "팀" }),
    column.accessor((row) => row.score, {
      id: "score",
      header: "활용지수",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.score)}</span>,
    }),
    column.accessor((row) => row.requests, {
      id: "requests",
      header: "요청",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.requests)}</span>,
    }),
    column.accessor((row) => row.active_days, {
      id: "active_days",
      header: "활동일",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.active_days)}</span>,
    }),
    column.accessor((row) => row.commits, {
      id: "commits",
      header: "commit",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.commits)}</span>,
    }),
    column.accessor((row) => row.merged_mrs, {
      id: "merged_mrs",
      header: "머지된 MR",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.merged_mrs)}</span>,
    }),
    column.accessor((row) => row.tool_calls, {
      id: "tool_calls",
      header: "도구 호출",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.tool_calls)}</span>,
    }),
    column.accessor((row) => row.success_rate, {
      id: "success_rate",
      header: "성공률",
      cell: ({ row }) => <span className="cell-number">{formatPercent(row.original.success_rate)}</span>,
    }),
    column.accessor((row) => row.cost_krw, {
      id: "cost",
      header: "비용",
      cell: ({ row }) => <span className="cell-number">{formatKRW(row.original.cost_krw)}</span>,
    }),
  ]);
}

function benchmarkTeamColumns(): ReadonlyArray<DataTableColumn<BenchmarkTeamRow>> {
  const column = createDataTableColumnHelper<BenchmarkTeamRow>();
  return column.columns([
    column.accessor((row) => row.team, { id: "team", header: "팀" }),
    column.accessor((row) => row.score, {
      id: "score",
      header: "활용지수",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.score)}</span>,
    }),
    column.accessor((row) => row.active_users, {
      id: "active_users",
      header: "활동 사용자",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.active_users)}</span>,
    }),
    column.accessor((row) => row.requests, {
      id: "requests",
      header: "요청",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.requests)}</span>,
    }),
    column.accessor((row) => row.tokens, {
      id: "tokens",
      header: "토큰",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.tokens)}</span>,
    }),
    column.accessor((row) => row.success_rate, {
      id: "success_rate",
      header: "성공률",
      cell: ({ row }) => <span className="cell-number">{formatPercent(row.original.success_rate)}</span>,
    }),
    column.accessor((row) => row.commits, {
      id: "commits",
      header: "commit",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.commits)}</span>,
    }),
    column.accessor((row) => row.merged_mrs, {
      id: "merged_mrs",
      header: "머지된 MR",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.merged_mrs)}</span>,
    }),
    column.accessor((row) => row.cost_krw, {
      id: "cost",
      header: "비용",
      cell: ({ row }) => <span className="cell-number">{formatKRW(row.original.cost_krw)}</span>,
    }),
  ]);
}

export function ProductivityTab({
  refetchInterval,
  window: reportWindow,
}: {
  refetchInterval: number | false;
  window: ReportWindow;
}): React.JSX.Element {
  const days = reportWindowDays[reportWindow];
  const repoCols = useMemo(() => repoColumns(), []);
  const userCols = useMemo(() => benchmarkUserColumns(), []);
  const teamCols = useMemo(() => benchmarkTeamColumns(), []);

  const [productivity, benchmarkUsers, benchmarkTeams] = useQueries({
    queries: [
      {
        queryKey: ["governance", "productivity", days],
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          apiClient.request(endpoints.domains.governanceReports.productivity, {
            query: { days },
            signal,
            routeId: "governance.reports",
          }),
        refetchInterval,
        refetchIntervalInBackground: false,
      },
      {
        queryKey: ["governance", "benchmark-users", reportWindow],
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          apiClient.request(endpoints.domains.governanceReports.benchmarkUsers, {
            query: { window: reportWindow, limit: benchmarkLimit },
            signal,
            routeId: "governance.reports",
          }),
        refetchInterval,
        refetchIntervalInBackground: false,
      },
      {
        queryKey: ["governance", "benchmark-teams", reportWindow],
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          apiClient.request(endpoints.domains.governanceReports.benchmarkTeams, {
            query: { window: reportWindow },
            signal,
            routeId: "governance.reports",
          }),
        refetchInterval,
        refetchIntervalInBackground: false,
      },
    ],
  });

  const totals = productivity.data?.totals ?? { ai_requests: 0, merged: 0, ai_cost_krw: 0 };
  const repos = productivity.data?.repos ?? [];
  const users = benchmarkUsers.data?.users ?? [];
  const teams = benchmarkTeams.data?.teams ?? [];
  const costPerMerged = totals.merged > 0 ? totals.ai_cost_krw / totals.merged : 0;
  const topUsers = [...users]
    .sort((left, right) => right.score - left.score)
    .slice(0, 8)
    .map((user) => ({
      label: user.name || user.api_key_id,
      value: user.score,
      display: `${formatNumber(user.score)}점`,
    }));

  return (
    <div className="gov-stack">
      {productivity.isError ? (
        <PanelFailure
          error={productivity.error}
          label="AI 업무성과"
          onRetry={() => void productivity.refetch()}
        />
      ) : null}
      <StatGrid label="AI 업무성과 요약">
        <StatCard label="AI 요청" value={formatNumber(totals.ai_requests)} />
        <StatCard label="AI 비용" value={formatKRW(totals.ai_cost_krw)} />
        <StatCard label="머지" value={formatNumber(totals.merged)} />
        <StatCard
          label="머지당 비용"
          value={totals.merged > 0 ? formatKRW(costPerMerged) : "—"}
          hint="VCS 이벤트가 없는 repo는 산출이 0으로 집계됩니다."
        />
      </StatGrid>

      <SectionCard
        headingLevel={2}
        title={`repo별 AI 사용 ↔ 개발 산출 (최근 ${formatNumber(productivity.data?.days ?? days)}일)`}
        description="“얼마나 썼나”가 아니라 “무엇이 머지됐나”의 관점으로 비교합니다."
      >
        <DataTable
          caption="repo별 AI 업무성과"
          columns={repoCols}
          data={repos}
          getRowId={(row, index) => row.repo || `repo-${index}`}
          loading={productivity.isPending}
          error={
            productivity.isError
              ? safeAppErrorMessage(productivity.error, "AI 업무성과를 불러오지 못했습니다.")
              : undefined
          }
          onRetry={() => void productivity.refetch()}
          emptyMessage="repo 귀속 데이터가 없습니다."
        />
        {!productivity.isPending && !productivity.isError && repos.length === 0 ? (
          <EmptyState
            title="repo에 귀속된 AI 사용량이 없습니다."
            description="게이트웨이 호출에 X-Vibe-Repo 헤더를 붙이면 repo별로 집계됩니다."
          />
        ) : null}
        {productivity.data?.note ? <p className="gov-note">{productivity.data.note}</p> : null}
      </SectionCard>

      <SectionCard
        headingLevel={2}
        title="사용자 AI 활용지수"
        description="요청·활동일·commit·머지된 MR을 합성한 0~100 지수입니다."
      >
        {benchmarkUsers.isError ? (
          <PanelFailure
            error={benchmarkUsers.error}
            label="사용자 활용지수"
            onRetry={() => void benchmarkUsers.refetch()}
          />
        ) : null}
        {topUsers.length > 0 ? <ScoreBars data={topUsers} max={100} /> : null}
        <DataTable
          caption="사용자 AI 활용지수"
          columns={userCols}
          data={users}
          getRowId={(row, index) => row.api_key_id || `user-${index}`}
          loading={benchmarkUsers.isPending}
          error={
            benchmarkUsers.isError
              ? safeAppErrorMessage(benchmarkUsers.error, "활용지수를 불러오지 못했습니다.")
              : undefined
          }
          onRetry={() => void benchmarkUsers.refetch()}
          emptyMessage="표시할 사용자 활용지수가 없습니다."
        />
      </SectionCard>

      <SectionCard
        headingLevel={2}
        title="팀 벤치마크"
        description="팀 단위로 비용과 관측된 개발 산출을 비교합니다."
      >
        {benchmarkTeams.isError ? (
          <PanelFailure
            error={benchmarkTeams.error}
            label="팀 벤치마크"
            onRetry={() => void benchmarkTeams.refetch()}
          />
        ) : null}
        <DataTable
          caption="팀 벤치마크"
          columns={teamCols}
          data={teams}
          getRowId={(row, index) => row.team || `bench-team-${index}`}
          loading={benchmarkTeams.isPending}
          error={
            benchmarkTeams.isError
              ? safeAppErrorMessage(benchmarkTeams.error, "팀 벤치마크를 불러오지 못했습니다.")
              : undefined
          }
          onRetry={() => void benchmarkTeams.refetch()}
          emptyMessage="표시할 팀 벤치마크가 없습니다."
        />
      </SectionCard>
    </div>
  );
}
