import { useMemo, useState } from "react";

import { QueryNotice } from "@/features/mcp/mcp-ui";
import type { McpRoute } from "@/shared/api/domains/mcp.schemas";
import { Badge } from "@/shared/components/ui/Badge";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { formatDateTime, formatNumber, formatPercent } from "@/shared/utils/format";

import { ErrorState, LoadingState, PermissionDenied } from "@/shared/components/state/PageStates";
import { useFeatureReadOwner, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { useMcpOverviewData } from "./use-mcp-overview-data";
import { McpCallConsole } from "./McpCallConsole";
import { emptyCall, type CallDraft } from "./mcp-call-review";

const column = createDataTableColumnHelper<McpRoute>();

function routeColumns(): ReadonlyArray<DataTableColumn<McpRoute>> {
  return [
    column.accessor((row) => row.kind, { id: "kind", header: "종류" }),
    column.accessor((row) => row.exposed_name || row.uri, {
      id: "name",
      header: "노출 이름",
      cell: (info) => <span className="mono">{info.getValue<string>() || "—"}</span>,
    }),
    column.accessor((row) => row.upstream_name, { id: "upstream", header: "업스트림" }),
    column.accessor((row) => row.target_method, { id: "method", header: "대상 메서드" }),
    column.accessor((row) => row.target_name, {
      id: "target",
      header: "대상 이름",
      cell: (info) => <span className="mono">{info.getValue<string>() || "—"}</span>,
    }),
    column.accessor((row) => row.discovery_error, {
      id: "error",
      header: "디스커버리 오류",
      cell: (info) =>
        info.getValue<string>() ? <Badge tone="danger">오류</Badge> : <Badge tone="success">정상</Badge>,
    }),
  ] as ReadonlyArray<DataTableColumn<McpRoute>>;
}

export function McpOverviewTab({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const owner = useFeatureReadOwner(
    "mcp.overview",
    "mcp-overview",
    ["observability:read", "mcp:admin"],
    "observability:read",
  );
  if (!owner.readable) return <PermissionDenied permission="observability:read" />;
  if (owner.denied)
    return (
      <ErrorState
        title="MCP 개요 조회 권한을 다시 확인하세요."
        message="이전 결과와 호출 입력을 표시하지 않습니다."
        onRetry={owner.restart}
        showLegacy={false}
      />
    );
  return <OverviewContent key={owner.id} owner={owner} canWrite={canWrite} />;
}
function OverviewContent({ owner, canWrite }: { owner: FeatureReadOwner; canWrite: boolean }) {
  const { overview, routes, topology } = useMcpOverviewData(owner);
  const [selection, setSelection] = useState<{ draft: CallDraft; revision: number }>({
    draft: emptyCall,
    revision: 0,
  });
  const summary = overview.data;
  const topologyCounts = useMemo(() => {
    const nodes = topology.data?.nodes ?? [];
    return {
      upstream: nodes.filter((node) => node.kind === "upstream").length,
      tool: nodes.filter((node) => node.kind === "tool").length,
      prompt: nodes.filter((node) => node.kind === "prompt").length,
      resource: nodes.filter((node) => node.kind === "resource").length,
      blocked: nodes.filter((node) => node.decision === "block").length,
    };
  }, [topology.data?.nodes]);

  return (
    <div className="mcp-section-stack">
      {overview.isError ? (
        <QueryNotice
          error={overview.error}
          hasData={Boolean(overview.data)}
          label="MCP 개요"
          onRetry={() => void overview.refetch()}
        />
      ) : null}

      <StatGrid label="MCP 운영 지표">
        <StatCard
          label="등록 업스트림"
          value={summary ? formatNumber(summary.upstream_count) : "—"}
          hint={summary ? `사용 중 ${formatNumber(summary.enabled_upstream_count)}개` : undefined}
        />
        <StatCard
          label="연결 정상 업스트림"
          tone={
            summary && summary.healthy_upstream_count < summary.enabled_upstream_count ? "warning" : "success"
          }
          value={summary ? formatNumber(summary.healthy_upstream_count) : "—"}
          hint="최근 디스커버리에서 라우트를 노출한 업스트림"
        />
        <StatCard
          label="노출 도구"
          value={summary ? formatNumber(summary.total_tools) : "—"}
          hint={
            summary
              ? `프롬프트 ${formatNumber(summary.total_prompts)} · 리소스 ${formatNumber(summary.total_resources)}`
              : undefined
          }
        />
        <StatCard
          label="최근 24시간 MCP 호출"
          value={summary ? formatNumber(summary.recent_call_count) : "—"}
          hint={summary ? `오류율 ${formatPercent(summary.recent_error_rate)}` : undefined}
          tone={summary && summary.recent_error_rate > 0.05 ? "warning" : "default"}
        />
        <StatCard
          label="차단 정책"
          value={summary ? formatNumber(summary.blocked_count) : "—"}
          hint="차단 모드 서버 정책과 도구 위험 프로필"
        />
        <StatCard
          label="디스커버리 오류"
          tone={summary && summary.discovery_error_count > 0 ? "danger" : "default"}
          value={summary ? formatNumber(summary.discovery_error_count) : "—"}
          hint={summary?.fetched_at ? `수집 ${formatDateTime(summary.fetched_at)}` : undefined}
        />
      </StatGrid>

      <McpCallConsole key={selection.revision} owner={owner} canWrite={canWrite} initial={selection.draft} />

      <SectionCard
        title="제공 기능 목록"
        description="게이트웨이가 외부 에이전트에 노출하는 도구·프롬프트·리소스 목록입니다."
        actions={
          routes.data?.fetched_at ? (
            <span className="mcp-note">수집 {formatDateTime(routes.data.fetched_at)}</span>
          ) : null
        }
      >
        {routes.isError ? (
          <QueryNotice
            error={routes.error}
            hasData={Boolean(routes.data)}
            label="제공 기능 목록"
            onRetry={() => void routes.refetch()}
          />
        ) : null}
        {!routes.isPending && !routes.isError && (routes.data?.routes.length ?? 0) === 0 ? (
          <EmptyState
            title="노출된 MCP 라우트가 없습니다."
            description="업스트림 탭에서 MCP 서버를 등록하고 사용으로 전환하면 도구가 여기에 나타납니다."
          />
        ) : (
          <DataTable
            caption="MCP 라우트 맵"
            columns={routeColumns()}
            data={routes.data?.routes ?? []}
            loading={routes.isPending}
            getRowId={(row, index) => `${row.kind}:${row.exposed_name || row.uri}:${index}`}
            getRowActionLabel={(row) => `${row.exposed_name || row.uri} 라우트 설명`}
            onRowClick={(row) => {
              const nextMethod = row.target_method || "tools/call";
              setSelection((previous) => ({
                draft: { method: nextMethod, name: row.exposed_name, uri: row.uri, arguments: "{}" },
                revision: previous.revision + 1,
              }));
            }}
          />
        )}
      </SectionCard>

      <SectionCard title="연결 구조 요약" description="게이트웨이 → 업스트림 → 라우트 연결 요약입니다.">
        {topology.isError ? (
          <QueryNotice
            error={topology.error}
            hasData={Boolean(topology.data)}
            label="연결 구조 요약"
            onRetry={() => void topology.refetch()}
          />
        ) : null}
        {topology.isPending ? (
          <LoadingState label="연결 요약을 불러오는 중입니다." />
        ) : topology.data ? (
          <KeyValueList
            columns={3}
            items={[
              { label: "업스트림 노드", value: formatNumber(topologyCounts.upstream) },
              { label: "도구 노드", value: formatNumber(topologyCounts.tool) },
              { label: "프롬프트 노드", value: formatNumber(topologyCounts.prompt) },
              { label: "리소스 노드", value: formatNumber(topologyCounts.resource) },
              { label: "차단 판단 노드", value: formatNumber(topologyCounts.blocked) },
              { label: "연결(엣지)", value: formatNumber(topology.data?.edges.length ?? 0) },
            ]}
          />
        ) : null}
        {Object.entries(routes.data?.errors ?? {}).map(([upstream, message]) => (
          <InlineNotice key={upstream} tone="warning" title={`${upstream} 디스커버리 오류`}>
            <p className="mono">{message}</p>
          </InlineNotice>
        ))}
      </SectionCard>
    </div>
  );
}
