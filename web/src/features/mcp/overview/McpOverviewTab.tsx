import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { QueryNotice } from "@/features/mcp/mcp-ui";
import { decisionLabel, decisionTone } from "@/features/mcp/mcp-utils";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import type { McpRoute } from "@/shared/api/domains/mcp.schemas";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { JsonBlock } from "@/shared/components/ui/JsonBlock";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Input } from "@/shared/components/ui/Input";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { formatDateTime, formatNumber, formatPercent } from "@/shared/utils/format";

const routeId = "mcp.overview";
const methodOptions = [
  { value: "tools/call", label: "tools/call (도구 호출)" },
  { value: "prompts/get", label: "prompts/get (프롬프트)" },
  { value: "resources/read", label: "resources/read (리소스)" },
  { value: "tools/list", label: "tools/list (연결 점검)" },
];

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
  const refetchInterval = useRefreshInterval();
  const [method, setMethod] = useState("tools/call");
  const [name, setName] = useState("");
  const [uri, setUri] = useState("");

  const overview = useQuery({
    queryKey: ["mcp", "overview"],
    queryFn: ({ signal }) => apiClient.request(endpoints.domains.mcp.overview, { signal, routeId }),
    refetchInterval,
    refetchIntervalInBackground: false,
  });
  const routes = useQuery({
    queryKey: ["mcp", "routes"],
    queryFn: ({ signal }) => apiClient.request(endpoints.domains.mcp.routes, { signal, routeId }),
    refetchInterval,
    refetchIntervalInBackground: false,
  });
  const topology = useQuery({
    queryKey: ["mcp", "topology"],
    queryFn: ({ signal }) => apiClient.request(endpoints.domains.mcp.topology, { signal, routeId }),
  });

  const explain = useMutationFeedback({
    mutate: (body: { method: string; name: string; uri: string }) =>
      apiClient.request(endpoints.domains.mcp.routeExplain, { body, routeId }),
    errorMessage: "라우트 설명을 확인하지 못했습니다.",
  });
  const test = useMutationFeedback({
    mutate: (body: { method: string; name: string; uri: string }) =>
      apiClient.request(endpoints.domains.mcp.test, { body, routeId }),
    successMessage: "MCP 테스트 호출을 실행했습니다.",
    errorMessage: "MCP 테스트 호출에 실패했습니다.",
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

  const consoleBody = { method, name: name.trim(), uri: uri.trim() };

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

      <SectionCard
        title="Route Explain · Test 콘솔"
        description="노출 이름으로 어떤 업스트림과 정책이 적용되는지 확인하고, 실제 호출로 연결을 점검합니다."
      >
        <form
          className="mcp-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            explain.mutate(consoleBody);
          }}
        >
          <label htmlFor="mcp-explain-method">
            메서드
            <Select
              id="mcp-explain-method"
              options={methodOptions}
              value={method}
              onChange={(event) => setMethod(event.target.value)}
            />
          </label>
          <label htmlFor="mcp-explain-name">
            노출 이름
            <Input
              id="mcp-explain-name"
              value={name}
              placeholder="예: github__create_issue"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label htmlFor="mcp-explain-uri">
            리소스 URI
            <Input
              id="mcp-explain-uri"
              value={uri}
              placeholder="예: gateway://models"
              onChange={(event) => setUri(event.target.value)}
            />
          </label>
          <Button type="submit" variant="primary" disabled={explain.isPending}>
            {explain.isPending ? "확인 중" : "라우트 설명"}
          </Button>
          <Button
            type="button"
            disabled={!canWrite || test.isPending}
            title={canWrite ? undefined : "mcp:admin 권한이 필요합니다."}
            onClick={() => test.mutate(consoleBody)}
          >
            {test.isPending ? "호출 중" : "테스트 호출"}
          </Button>
        </form>

        {explain.data ? (
          <KeyValueList
            items={[
              { label: "라우트 확인", value: explain.data.route?.found ? "찾음" : "없음" },
              { label: "업스트림", value: explain.data.route?.upstream_name ?? "—" },
              { label: "대상 메서드", value: explain.data.route?.target_method ?? "—", mono: true },
              { label: "대상 이름", value: explain.data.route?.target_name ?? "—", mono: true },
              { label: "서버 정책", value: decisionLabel(explain.data.policy?.server_policy ?? "") },
              { label: "도구 위험도", value: explain.data.policy?.tool_risk_level ?? "—" },
              {
                label: "최종 판단",
                value: (
                  <Badge tone={decisionTone(explain.data.final?.decision ?? "")}>
                    {decisionLabel(explain.data.final?.decision ?? "")}
                  </Badge>
                ),
              },
              { label: "판단 근거", value: explain.data.final?.reason ?? "—" },
            ]}
          />
        ) : null}

        {test.data ? (
          <InlineNotice
            tone={test.data.ok ? "success" : "danger"}
            title={test.data.ok ? "호출 성공" : "호출 실패"}
          >
            <p>
              {test.data.upstream_name || test.data.upstream_id || "업스트림"} · {test.data.method} ·{" "}
              {formatNumber(test.data.latency_ms)}ms
            </p>
            {test.data.error ? <p className="mono">{test.data.error}</p> : null}
            {test.data.response_preview ? (
              <JsonBlock label="응답 미리보기" value={test.data.response_preview} maxHeight={200} />
            ) : null}
          </InlineNotice>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Route Map"
        description="게이트웨이가 외부 에이전트에 노출하는 도구·프롬프트·리소스 목록입니다."
        actions={
          routes.data?.fetched_at ? (
            <span className="mcp-note">수집 {formatDateTime(routes.data.fetched_at)}</span>
          ) : null
        }
      >
        {routes.isError && !routes.data ? (
          <QueryNotice
            error={routes.error}
            hasData={false}
            label="Route Map"
            onRetry={() => void routes.refetch()}
          />
        ) : null}
        {!routes.isPending && (routes.data?.routes.length ?? 0) === 0 ? (
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
              setMethod(nextMethod);
              setName(row.exposed_name);
              setUri(row.uri);
              explain.mutate({ method: nextMethod, name: row.exposed_name, uri: row.uri });
            }}
          />
        )}
      </SectionCard>

      <SectionCard title="토폴로지" description="게이트웨이 → 업스트림 → 라우트 연결 요약입니다.">
        {topology.isError && !topology.data ? (
          <QueryNotice
            error={topology.error}
            hasData={false}
            label="토폴로지"
            onRetry={() => void topology.refetch()}
          />
        ) : (
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
        )}
        {Object.entries(routes.data?.errors ?? {}).map(([upstream, message]) => (
          <InlineNotice key={upstream} tone="warning" title={`${upstream} 디스커버리 오류`}>
            <p className="mono">{message}</p>
          </InlineNotice>
        ))}
      </SectionCard>
    </div>
  );
}
