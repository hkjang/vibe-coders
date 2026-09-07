import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { QueryNotice } from "@/features/mcp/mcp-ui";
import { detailText, stepTone } from "@/features/mcp/mcp-utils";
import { apiClient } from "@/shared/api/client";
import { withMcpPathParams } from "@/shared/api/domains/mcp";
import type { McpFlowStep, McpRequest } from "@/shared/api/domains/mcp.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { Input } from "@/shared/components/ui/Input";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Sheet } from "@/shared/components/ui/Sheet";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

const routeId = "mcp.overview";

const requestColumn = createDataTableColumnHelper<McpRequest>();
const requestColumns = [
  requestColumn.accessor((row) => formatDateTime(row.created_at), { id: "created", header: "시각" }),
  requestColumn.accessor((row) => row.id, {
    id: "id",
    header: "요청 ID",
    cell: (info) => <span className="mono truncate">{info.getValue<string>()}</span>,
  }),
  requestColumn.accessor((row) => row.api_key_id || "—", { id: "key", header: "API 키" }),
  requestColumn.accessor((row) => row.model || "—", { id: "model", header: "모델" }),
  requestColumn.accessor((row) => row.status_code, {
    id: "status",
    header: "상태",
    cell: (info) => {
      const status = info.getValue<number>();
      return (
        <Badge tone={status >= 500 ? "danger" : status >= 400 ? "warning" : "success"}>
          {formatNumber(status)}
        </Badge>
      );
    },
  }),
  requestColumn.accessor((row) => `${formatNumber(row.latency_ms)}ms`, {
    id: "latency",
    header: "지연",
  }),
  requestColumn.accessor((row) => formatNumber(row.tool_count), { id: "tools", header: "도구 호출" }),
] as ReadonlyArray<DataTableColumn<McpRequest>>;

const stepColumn = createDataTableColumnHelper<McpFlowStep>();
const stepColumns = [
  stepColumn.accessor((row) => row.name, { id: "name", header: "단계" }),
  stepColumn.accessor((row) => detailText(row.status), {
    id: "status",
    header: "상태",
    cell: (info) => <Badge tone={stepTone(info.getValue<string>())}>{info.getValue<string>()}</Badge>,
  }),
  stepColumn.accessor((row) => detailText(row.detail), {
    id: "detail",
    header: "내용",
    cell: (info) => <span className="truncate">{info.getValue<string>()}</span>,
  }),
] as ReadonlyArray<DataTableColumn<McpFlowStep>>;

interface ToolInvocationRow {
  server_label: string;
  tool_name: string;
  is_mcp: boolean;
  is_error: boolean;
  created_at: string;
}
const invocationColumn = createDataTableColumnHelper<ToolInvocationRow>();
const invocationColumns = [
  invocationColumn.accessor((row) => `${row.server_label}/${row.tool_name}`, {
    id: "tool",
    header: "서버/도구",
    cell: (info) => <span className="mono">{info.getValue<string>()}</span>,
  }),
  invocationColumn.accessor((row) => (row.is_mcp ? "MCP" : "일반"), { id: "kind", header: "유형" }),
  invocationColumn.accessor((row) => (row.is_error ? "오류" : "정상"), {
    id: "result",
    header: "결과",
    cell: (info) => (
      <Badge tone={info.getValue<string>() === "오류" ? "danger" : "success"}>
        {info.getValue<string>()}
      </Badge>
    ),
  }),
  invocationColumn.accessor((row) => formatDateTime(row.created_at), { id: "created", header: "시각" }),
] as ReadonlyArray<DataTableColumn<ToolInvocationRow>>;

export function McpRequestsTab(): React.JSX.Element {
  const refetchInterval = useRefreshInterval();
  const [params, updateParams] = useSearchState();
  const [searchError, setSearchError] = useState<string | undefined>();
  const tableRef = useRef<HTMLElement>(null);

  const server = params.get("server") ?? "";
  const tool = params.get("tool") ?? "";
  const errorsOnly = params.get("errors") === "1";
  const requestId = params.get("request_id") ?? "";

  const requests = useQuery({
    queryKey: ["mcp", "requests", server, tool, errorsOnly],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.mcp.requests, {
        query: {
          ...(server ? { server } : {}),
          ...(tool ? { tool } : {}),
          ...(errorsOnly ? { errors: "1" as const } : {}),
          limit: 50,
        },
        signal,
        routeId,
      }),
    refetchInterval,
    refetchIntervalInBackground: false,
  });

  const waterfall = useQuery({
    queryKey: ["mcp", "requests", requestId, "waterfall"],
    queryFn: ({ signal }) =>
      apiClient.request(withMcpPathParams(endpoints.domains.mcp.requestWaterfall, { id: requestId }), {
        signal,
        routeId,
      }),
    enabled: requestId !== "",
  });

  const agentic = useQuery({
    queryKey: ["mcp", "agentic-runs", requestId],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.mcp.agenticRuns, {
        query: { request_id: requestId },
        signal,
        routeId,
      }),
    enabled: requestId !== "",
  });

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
      errors: data.get("errors") === "on" ? "1" : undefined,
    });
  };

  const rows = requests.data?.requests ?? [];

  return (
    <div className="mcp-section-stack">
      <SectionCard title="MCP 요청 필터" description="서버·도구로 최근 MCP 호출 이력을 좁혀 봅니다.">
        <form className="mcp-filter-grid" onSubmit={applyFilters}>
          <label htmlFor="mcp-req-server">
            서버 라벨
            <Input id="mcp-req-server" name="server" defaultValue={server} key={`server-${server}`} />
          </label>
          <label htmlFor="mcp-req-tool">
            도구 이름
            <Input id="mcp-req-tool" name="tool" defaultValue={tool} key={`tool-${tool}`} />
          </label>
          <label htmlFor="mcp-req-errors" className="checkbox">
            <input id="mcp-req-errors" name="errors" type="checkbox" defaultChecked={errorsOnly} />
            <span className="checkbox-copy">
              <span>오류만 보기</span>
            </span>
          </label>
          <div className="mcp-row-actions">
            <Button type="submit" variant="primary">
              적용
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => updateParams({ server: undefined, tool: undefined, errors: undefined })}
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

      {requests.isError ? (
        <QueryNotice
          error={requests.error}
          hasData={Boolean(requests.data)}
          label="MCP 요청 로그"
          onRetry={() => void requests.refetch()}
        />
      ) : null}

      <SectionCard
        title="최근 MCP 호출"
        description="행을 선택하면 라우팅 워터폴과 도구 호출을 볼 수 있습니다."
      >
        {!requests.isPending && rows.length === 0 ? (
          <EmptyState
            title="MCP 호출 기록이 없습니다."
            description="에이전트가 /mcp 엔드포인트로 도구를 호출하면 이력이 쌓입니다."
          />
        ) : (
          <DataTable
            caption="최근 MCP 요청"
            columns={requestColumns}
            data={rows}
            loading={requests.isPending}
            getRowId={(row) => row.id}
            getRowActionLabel={(row) => `${row.id} 워터폴 열기`}
            onRowClick={(row) => updateParams({ request_id: row.id })}
          />
        )}
      </SectionCard>

      <Sheet
        open={requestId !== ""}
        onOpenChange={(open) => {
          if (!open) updateParams({ request_id: undefined });
        }}
        returnFocusRef={tableRef}
        size="wide"
        title="MCP 요청 워터폴"
        description="요청 하나의 인증부터 정책 판단, 업스트림 호출까지의 단계입니다."
      >
        {waterfall.isError ? (
          <QueryNotice
            error={waterfall.error}
            hasData={Boolean(waterfall.data)}
            label="워터폴"
            onRetry={() => void waterfall.refetch()}
          />
        ) : null}
        <KeyValueList
          items={[
            { label: "요청 ID", value: waterfall.data?.request_id || requestId, mono: true },
            { label: "트레이스 ID", value: waterfall.data?.trace_id || "—", mono: true },
            { label: "API 키", value: waterfall.data?.api_key_id || "—" },
            { label: "상태 코드", value: waterfall.data ? formatNumber(waterfall.data.status) : "—" },
            {
              label: "지연",
              value: waterfall.data ? `${formatNumber(waterfall.data.latency_ms)}ms` : "—",
            },
            {
              label: "에이전틱 실행",
              value: agentic.data ? (agentic.data.agentic ? "기록 있음" : "기록 없음") : "—",
            },
          ]}
        />
        {agentic.data && !agentic.data.agentic && agentic.data.note ? (
          <p className="mcp-note">{agentic.data.note}</p>
        ) : null}

        <SectionCard headingLevel={3} title="처리 단계">
          <DataTable
            caption="MCP 요청 처리 단계"
            columns={stepColumns}
            data={waterfall.data?.steps ?? []}
            loading={waterfall.isPending}
            getRowId={(row, index) => `${row.name}:${index}`}
          />
        </SectionCard>

        <SectionCard headingLevel={3} title="도구 호출">
          <DataTable
            caption="요청의 도구 호출"
            columns={invocationColumns}
            data={waterfall.data?.tools ?? []}
            getRowId={(row, index) => `${row.server_label}:${row.tool_name}:${index}`}
            emptyMessage="도구 호출이 없습니다."
          />
        </SectionCard>
      </Sheet>
    </div>
  );
}
