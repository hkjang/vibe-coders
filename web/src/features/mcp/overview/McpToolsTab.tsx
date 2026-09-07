import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { QueryNotice } from "@/features/mcp/mcp-ui";
import { riskTone } from "@/features/mcp/mcp-utils";
import { apiClient } from "@/shared/api/client";
import type { McpToolQuery } from "@/shared/api/domains/mcp";
import type { McpToolRisk, McpToolStat } from "@/shared/api/domains/mcp.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { formatDateTime, formatNumber, formatPercent } from "@/shared/utils/format";

const routeId = "mcp.overview";

const riskOptions = [
  { value: "", label: "전체 위험도" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "critical", label: "critical" },
];
const actionOptions = [
  { value: "", label: "전체 조치" },
  { value: "allow", label: "allow (허용)" },
  { value: "require_approval", label: "require_approval (승인)" },
  { value: "block", label: "block (차단)" },
];
const configuredOptions = [
  { value: "", label: "전체" },
  { value: "true", label: "설정됨" },
  { value: "false", label: "기본값" },
];

interface ToolRow extends McpToolRisk {
  calls: number;
  errors: number;
  errorRate: number;
  lastSeen: string;
}

const toolColumn = createDataTableColumnHelper<ToolRow>();
const toolColumns = [
  toolColumn.accessor((row) => row.server_label, { id: "server", header: "서버" }),
  toolColumn.accessor((row) => row.tool_name, {
    id: "tool",
    header: "도구",
    cell: (info) => <span className="mono">{info.getValue<string>()}</span>,
  }),
  toolColumn.accessor((row) => row.access_class, { id: "class", header: "접근 유형" }),
  toolColumn.accessor((row) => row.risk_level, {
    id: "risk",
    header: "위험도",
    cell: (info) => <Badge tone={riskTone(info.getValue<string>())}>{info.getValue<string>()}</Badge>,
  }),
  toolColumn.accessor((row) => row.action, {
    id: "action",
    header: "조치",
    cell: (info) => (
      <Badge tone={info.getValue<string>() === "block" ? "danger" : "muted"}>{info.getValue<string>()}</Badge>
    ),
  }),
  toolColumn.accessor((row) => (row.configured ? "설정됨" : "기본값"), {
    id: "configured",
    header: "설정 상태",
  }),
  toolColumn.accessor((row) => row.calls, {
    id: "calls",
    header: "호출",
    cell: (info) => <span className="cell-number">{formatNumber(info.getValue<number>())}</span>,
  }),
  toolColumn.accessor((row) => row.errorRate, {
    id: "errorRate",
    header: "오류율",
    cell: (info) => <span className="cell-number">{formatPercent(info.getValue<number>())}</span>,
  }),
  toolColumn.accessor((row) => row.lastSeen, {
    id: "lastSeen",
    header: "최근 호출",
    cell: (info) => formatDateTime(info.getValue<string>()),
  }),
] as ReadonlyArray<DataTableColumn<ToolRow>>;

interface ServerRow {
  server_label: string;
  is_mcp: boolean;
  tools: number;
  calls: number;
  errors: number;
  error_rate: number;
  distinct_keys: number;
  last_seen: string;
}
const serverColumn = createDataTableColumnHelper<ServerRow>();
const serverColumns = [
  serverColumn.accessor((row) => row.server_label, { id: "server", header: "서버" }),
  serverColumn.accessor((row) => (row.is_mcp ? "MCP" : "일반 도구"), { id: "kind", header: "유형" }),
  serverColumn.accessor((row) => formatNumber(row.tools), { id: "tools", header: "도구 수" }),
  serverColumn.accessor((row) => formatNumber(row.calls), { id: "calls", header: "호출" }),
  serverColumn.accessor((row) => formatNumber(row.errors), { id: "errors", header: "오류" }),
  serverColumn.accessor((row) => formatPercent(row.error_rate), { id: "rate", header: "오류율" }),
  serverColumn.accessor((row) => formatNumber(row.distinct_keys), { id: "keys", header: "사용 키" }),
  serverColumn.accessor((row) => formatDateTime(row.last_seen), { id: "last", header: "최근" }),
] as ReadonlyArray<DataTableColumn<ServerRow>>;

interface CatalogRow {
  server_label: string;
  tool_name: string;
  first_seen: string;
  last_seen: string;
  is_new: boolean;
  is_stale: boolean;
}
const catalogColumn = createDataTableColumnHelper<CatalogRow>();
const catalogColumns = [
  catalogColumn.accessor((row) => row.server_label, { id: "server", header: "서버" }),
  catalogColumn.accessor((row) => row.tool_name, {
    id: "tool",
    header: "도구",
    cell: (info) => <span className="mono">{info.getValue<string>()}</span>,
  }),
  catalogColumn.accessor((row) => (row.is_new ? "신규" : row.is_stale ? "유휴" : "정상"), {
    id: "state",
    header: "상태",
    cell: (info) => {
      const label = info.getValue<string>();
      return (
        <Badge tone={label === "신규" ? "warning" : label === "유휴" ? "muted" : "success"}>{label}</Badge>
      );
    },
  }),
  catalogColumn.accessor((row) => formatDateTime(row.first_seen), { id: "first", header: "최초 관측" }),
  catalogColumn.accessor((row) => formatDateTime(row.last_seen), { id: "last", header: "최근 관측" }),
] as ReadonlyArray<DataTableColumn<CatalogRow>>;

interface TrustRow {
  ref: string;
  trust_score: number;
  grade: string;
  risk_level: string;
  calls: number;
  error_rate_pct: number;
  confidence: string;
}
const trustColumn = createDataTableColumnHelper<TrustRow>();
const trustColumns = [
  trustColumn.accessor((row) => row.ref, {
    id: "ref",
    header: "서버/도구",
    cell: (info) => <span className="mono">{info.getValue<string>()}</span>,
  }),
  trustColumn.accessor((row) => row.trust_score, {
    id: "score",
    header: "신뢰 점수",
    cell: (info) => <span className="cell-number">{formatNumber(info.getValue<number>(), 1)}</span>,
  }),
  trustColumn.accessor((row) => row.grade, {
    id: "grade",
    header: "등급",
    cell: (info) => {
      const grade = info.getValue<string>();
      return <Badge tone={grade === "A" ? "success" : grade === "D" ? "danger" : "warning"}>{grade}</Badge>;
    },
  }),
  trustColumn.accessor((row) => row.risk_level, { id: "risk", header: "위험도" }),
  trustColumn.accessor((row) => formatNumber(row.calls), { id: "calls", header: "호출" }),
  trustColumn.accessor((row) => `${formatNumber(row.error_rate_pct, 1)}%`, {
    id: "rate",
    header: "오류율",
  }),
  trustColumn.accessor((row) => (row.confidence === "low" ? "표본 부족" : "충분"), {
    id: "confidence",
    header: "표본",
  }),
] as ReadonlyArray<DataTableColumn<TrustRow>>;

export function McpToolsTab(): React.JSX.Element {
  const refetchInterval = useRefreshInterval();
  const [params, updateParams] = useSearchState();
  const [searchError, setSearchError] = useState<string | undefined>();

  const server = params.get("server") ?? "";
  const tool = params.get("tool") ?? "";
  const risk = params.get("risk_level") ?? "";
  const action = params.get("action") ?? "";
  const configured = params.get("configured") ?? "";
  const mcpOnly = params.get("mcp_only") === "1";

  const query: McpToolQuery = {
    ...(server ? { server } : {}),
    ...(tool ? { tool } : {}),
    ...(risk ? { risk_level: risk } : {}),
    ...(action ? { action } : {}),
    ...(configured === "true" || configured === "false" ? { configured } : {}),
    ...(mcpOnly ? { mcp_only: "1" as const } : {}),
    limit: 200,
  };

  const tools = useQuery({
    queryKey: ["mcp", "tools", query],
    queryFn: ({ signal }) => apiClient.request(endpoints.domains.mcp.tools, { query, signal, routeId }),
    refetchInterval,
    refetchIntervalInBackground: false,
  });
  const servers = useQuery({
    queryKey: ["mcp", "servers", server, tool, mcpOnly],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.mcp.servers, {
        query: {
          ...(server ? { server } : {}),
          ...(tool ? { tool } : {}),
          ...(mcpOnly ? { mcp_only: "1" as const } : {}),
          limit: 200,
        },
        signal,
        routeId,
      }),
  });
  const catalog = useQuery({
    queryKey: ["mcp", "catalog", server],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.mcp.catalog, {
        query: server ? { server } : {},
        signal,
        routeId,
      }),
  });
  const trust = useQuery({
    queryKey: ["mcp", "trust-scores"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.mcp.trustScores, { query: { days: 30 }, signal, routeId }),
  });

  const toolRows = useMemo<ToolRow[]>(() => {
    const stats = new Map<string, McpToolStat>();
    for (const stat of tools.data?.tools ?? []) {
      stats.set(`${stat.server_label} ${stat.tool_name}`, stat);
    }
    return (tools.data?.tool_risk ?? []).map((risky) => {
      const stat = stats.get(`${risky.server_label} ${risky.tool_name}`);
      return {
        ...risky,
        calls: stat?.calls ?? 0,
        errors: stat?.errors ?? 0,
        errorRate: stat?.error_rate ?? 0,
        lastSeen: stat?.last_seen ?? "",
      };
    });
  }, [tools.data?.tool_risk, tools.data?.tools]);

  const applyFilters = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const nextServer = String(data.get("server") ?? "").trim();
    const nextTool = String(data.get("tool") ?? "").trim();
    if (containsPotentialSecret(nextServer) || containsPotentialSecret(nextTool)) {
      setSearchError(secretSearchMessage);
      return;
    }
    setSearchError(undefined);
    updateParams({
      server: nextServer || undefined,
      tool: nextTool || undefined,
      risk_level: String(data.get("risk_level") ?? "") || undefined,
      action: String(data.get("action") ?? "") || undefined,
      configured: String(data.get("configured") ?? "") || undefined,
      mcp_only: data.get("mcp_only") === "on" ? "1" : undefined,
    });
  };

  return (
    <div className="mcp-section-stack">
      <SectionCard title="도구 필터" description="서버·도구 이름과 위험 등급으로 목록을 좁힙니다.">
        <form className="mcp-filter-grid" onSubmit={applyFilters}>
          <label htmlFor="mcp-tools-server">
            서버 라벨
            <Input id="mcp-tools-server" name="server" defaultValue={server} key={`server-${server}`} />
          </label>
          <label htmlFor="mcp-tools-tool">
            도구 이름
            <Input id="mcp-tools-tool" name="tool" defaultValue={tool} key={`tool-${tool}`} />
          </label>
          <label htmlFor="mcp-tools-risk">
            위험도
            <Select
              id="mcp-tools-risk"
              name="risk_level"
              defaultValue={risk}
              options={riskOptions}
              key={`risk-${risk}`}
            />
          </label>
          <label htmlFor="mcp-tools-action">
            조치
            <Select
              id="mcp-tools-action"
              name="action"
              defaultValue={action}
              options={actionOptions}
              key={`action-${action}`}
            />
          </label>
          <label htmlFor="mcp-tools-configured">
            설정 상태
            <Select
              id="mcp-tools-configured"
              name="configured"
              defaultValue={configured}
              options={configuredOptions}
              key={`configured-${configured}`}
            />
          </label>
          <label htmlFor="mcp-tools-mcponly" className="checkbox">
            <input id="mcp-tools-mcponly" name="mcp_only" type="checkbox" defaultChecked={mcpOnly} />
            <span className="checkbox-copy">
              <span>MCP 도구만</span>
            </span>
          </label>
          <div className="mcp-row-actions">
            <Button type="submit" variant="primary">
              적용
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                updateParams({
                  server: undefined,
                  tool: undefined,
                  risk_level: undefined,
                  action: undefined,
                  configured: undefined,
                  mcp_only: undefined,
                })
              }
            >
              초기화
            </Button>
          </div>
        </form>
        {searchError ? (
          <p className="form-error" role="alert">
            {searchError}
          </p>
        ) : null}
      </SectionCard>

      <InlineNotice tone="warning" title="도구 위험도 저장은 이 화면에서 지원하지 않습니다.">
        위험 등급과 조치를 저장하는 API(POST /admin/mcp/tools)가 공개 API 목록에 없어 이식하지 못했습니다.
        변경이 필요하면 <a href="/admin#/mcp-tools">기존 화면에서 열기</a>를 이용하세요.
      </InlineNotice>

      {tools.isError ? (
        <QueryNotice
          error={tools.error}
          hasData={Boolean(tools.data)}
          label="도구 위험 등급"
          onRetry={() => void tools.refetch()}
        />
      ) : null}

      <SectionCard title="도구 위험 등급" description="MCP 도구별 위험 등급, 조치와 최근 호출 통계입니다.">
        {!tools.isPending && toolRows.length === 0 ? (
          <EmptyState
            title="조건에 맞는 도구가 없습니다."
            description="MCP 도구가 한 번이라도 호출되면 여기에 나타납니다. 필터를 초기화해 보세요."
          />
        ) : (
          <DataTable
            caption="MCP 도구 위험 등급"
            columns={toolColumns}
            data={toolRows}
            loading={tools.isPending}
            getRowId={(row) => `${row.server_label}/${row.tool_name}`}
          />
        )}
      </SectionCard>

      <SectionCard title="서버별 사용량" description="도구를 노출한 서버 라벨 기준 호출과 오류 통계입니다.">
        {servers.isError ? (
          <QueryNotice
            error={servers.error}
            hasData={Boolean(servers.data)}
            label="서버 사용량"
            onRetry={() => void servers.refetch()}
          />
        ) : null}
        <DataTable
          caption="MCP 서버별 사용량"
          columns={serverColumns}
          data={servers.data?.servers ?? []}
          loading={servers.isPending}
          getRowId={(row) => row.server_label}
          emptyMessage="집계된 서버가 없습니다."
        />
      </SectionCard>

      <SectionCard
        title="도구 카탈로그"
        description="최근 24시간 안에 새로 나타났거나 오랫동안 호출되지 않은 도구를 표시합니다."
        actions={
          catalog.data ? (
            <span className="mcp-note">신규 {formatNumber(catalog.data.new_count)}개</span>
          ) : null
        }
      >
        <DataTable
          caption="MCP 도구 카탈로그"
          columns={catalogColumns}
          data={catalog.data?.catalog ?? []}
          loading={catalog.isPending}
          getRowId={(row) => `${row.server_label}/${row.tool_name}`}
          emptyMessage="관측된 도구가 없습니다."
        />
      </SectionCard>

      <SectionCard title="도구 신뢰 점수" description="최근 30일 오류율과 위험 등급으로 계산한 점수입니다.">
        <DataTable
          caption="MCP 도구 신뢰 점수"
          columns={trustColumns}
          data={trust.data?.tools ?? []}
          loading={trust.isPending}
          getRowId={(row) => row.ref}
          emptyMessage="점수를 계산할 호출 기록이 없습니다."
        />
      </SectionCard>
    </div>
  );
}
