import { useQuery } from "@tanstack/react-query";

import { QueryNotice } from "@/features/mcp/mcp-ui";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime, formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";

const routeId = "agents.registry";
const windowOptions = [
  { value: "24h", label: "최근 24시간" },
  { value: "7d", label: "최근 7일" },
  { value: "30d", label: "최근 30일" },
];
const allowedWindows = new Set(windowOptions.map((option) => option.value));

interface AgentRow {
  agent: string;
  requests: number;
  success_rate: number;
  fallback_rate: number;
  tokens: number;
  total_cost_krw: number;
  avg_latency_ms: number;
  avg_first_chunk_ms: number;
  tool_error_rate: number;
  last_seen: string;
}

const column = createDataTableColumnHelper<AgentRow>();
const columns = [
  column.accessor((row) => row.agent, { id: "agent", header: "에이전트" }),
  column.accessor((row) => formatNumber(row.requests), { id: "requests", header: "요청" }),
  column.accessor((row) => formatPercent(row.success_rate), { id: "success", header: "성공률" }),
  column.accessor((row) => formatPercent(row.fallback_rate), { id: "fallback", header: "폴백률" }),
  column.accessor((row) => formatKRW(row.total_cost_krw), { id: "cost", header: "비용" }),
  column.accessor((row) => `${formatNumber(row.avg_latency_ms)}ms`, { id: "latency", header: "평균 지연" }),
  column.accessor((row) => `${formatNumber(row.avg_first_chunk_ms)}ms`, {
    id: "firstChunk",
    header: "첫 청크",
  }),
  column.accessor((row) => formatPercent(row.tool_error_rate), {
    id: "toolErrors",
    header: "도구 오류율",
  }),
  column.accessor((row) => formatNumber(row.tokens), { id: "tokens", header: "토큰" }),
  column.accessor((row) => formatDateTime(row.last_seen), { id: "last", header: "최근" }),
] as ReadonlyArray<DataTableColumn<AgentRow>>;

export function AgentPerformanceTab(): React.JSX.Element {
  const refetchInterval = useRefreshInterval();
  const [params, updateParams] = useSearchState();
  const requested = params.get("window") ?? "";
  const window = allowedWindows.has(requested) ? requested : "24h";

  const agents = useQuery({
    queryKey: ["agents", "analytics", window],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.mcp.agents.analytics, {
        query: { window },
        signal,
        routeId,
      }),
    refetchInterval,
    refetchIntervalInBackground: false,
  });

  const rows = agents.data?.agents ?? [];
  const totalRequests = rows.reduce((sum, row) => sum + row.requests, 0);
  const totalCost = rows.reduce((sum, row) => sum + row.total_cost_krw, 0);
  const weightedSuccess =
    totalRequests > 0
      ? rows.reduce((sum, row) => sum + row.success_rate * row.requests, 0) / totalRequests
      : 0;

  return (
    <div className="mcp-section-stack">
      {agents.isError ? (
        <QueryNotice
          error={agents.error}
          hasData={Boolean(agents.data)}
          label="에이전트 성능"
          onRetry={() => void agents.refetch()}
        />
      ) : null}

      <StatGrid label="에이전트 요약">
        <StatCard label="에이전트 수" value={formatNumber(rows.length)} />
        <StatCard label="총 요청" value={formatNumber(totalRequests)} />
        <StatCard label="가중 성공률" value={totalRequests > 0 ? formatPercent(weightedSuccess) : "—"} />
        <StatCard label="총 비용" value={formatKRW(totalCost)} />
      </StatGrid>

      <SectionCard
        title="에이전트 성능"
        description="User-Agent로 식별한 코딩 에이전트별 사용량과 품질 지표입니다."
        actions={
          <label htmlFor="agents-window" className="mcp-note">
            조회 기간
            <Select
              id="agents-window"
              options={windowOptions}
              value={window}
              onChange={(event) => updateParams({ window: event.target.value })}
            />
          </label>
        }
      >
        {!agents.isPending && rows.length === 0 ? (
          <EmptyState
            title="집계된 에이전트가 없습니다."
            description="Cursor, Claude Code 등 코딩 에이전트가 게이트웨이를 호출하면 여기에 표시됩니다."
          />
        ) : (
          <DataTable
            caption="에이전트별 성능"
            columns={columns}
            data={rows}
            loading={agents.isPending}
            getRowId={(row) => row.agent}
          />
        )}
      </SectionCard>
    </div>
  );
}
