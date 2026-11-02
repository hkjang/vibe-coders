import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/app/auth/AuthProvider";

import { QueryNotice } from "@/features/mcp/mcp-ui";
import { detailText, stepTone } from "@/features/mcp/mcp-utils";
import type { McpFlowStep, McpRequest } from "@/shared/api/domains/mcp.schemas";
import { ErrorState, PermissionDenied } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { Input } from "@/shared/components/ui/Input";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Sheet } from "@/shared/components/ui/Sheet";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { useFeatureReadOwner, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { useMcpRequestData } from "./use-mcp-request-data";
import { validMcpRequestId } from "./mcp-request-location";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

const stepNames: Readonly<Record<string, string>> = {
  auth: "인증 정보",
  mcp_detect: "MCP 호출 확인",
  route_lookup: "도구 경로",
  policy_evaluation: "현재 서버 정책",
  governance_evaluation: "현재 최종 조치",
  upstream_call: "업스트림 호출 결과",
  response: "응답",
  log_enqueue: "도구 기록 수",
};
const stepStates: Readonly<Record<string, string>> = {
  ok: "정상",
  warn: "경고",
  error: "오류",
  allow: "허용",
  block: "차단",
  require_approval: "승인 필요",
  approval_required: "승인 필요",
  not_in_allowlist: "허용목록 외",
};

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
  stepColumn.accessor((row) => stepNames[row.name] ?? row.name, { id: "name", header: "단계" }),
  stepColumn.accessor((row) => detailText(row.status), {
    id: "status",
    header: "상태",
    cell: (info) => (
      <Badge tone={stepTone(info.getValue<string>())}>
        {stepStates[info.getValue<string>()] ?? info.getValue<string>()}
      </Badge>
    ),
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
  const [params, updateParams] = useSearchState();
  const [recoveryOwner, setRecoveryOwner] = useState<number>();
  const owner = useFeatureReadOwner(
    "mcp.overview",
    "mcp-requests",
    ["observability:read"],
    "observability:read",
  );
  useEffect(() => {
    if (recoveryOwner === owner.id && !params.has("request_id")) owner.restart();
  }, [recoveryOwner, owner, params]);
  if (!owner.readable) return <PermissionDenied permission="observability:read" />;
  if (owner.denied)
    return (
      <ErrorState
        title="MCP 요청 조회 권한을 다시 확인하세요."
        message="이전 목록과 상세 내용을 표시하지 않습니다. 다시 시도하면 상세 선택을 해제하고 목록을 조회합니다."
        onRetry={() => {
          updateParams({ request_id: undefined });
          setRecoveryOwner(owner.id);
        }}
        showLegacy={false}
      />
    );
  return <McpRequestLocation key={owner.id} owner={owner} />;
}

function McpRequestLocation({ owner }: { owner: FeatureReadOwner }): React.JSX.Element {
  const auth = useAuth();
  const [params, updateParams] = useSearchState();
  const requestId = params.get("request_id") ?? "";
  const unsafe = ["server", "tool", "request_id"].some((key) =>
    containsPotentialSecret(params.get(key) ?? "", auth.credentialPrefixes),
  );
  if (unsafe || (requestId !== "" && !validMcpRequestId(requestId)))
    return (
      <ErrorState
        title="MCP 요청 조회 주소를 확인하세요."
        message="안전하지 않거나 지원하지 않는 조회 조건입니다. 조건을 초기화한 뒤 다시 선택하세요."
        onRetry={() => updateParams({ server: undefined, tool: undefined, request_id: undefined })}
        showLegacy={false}
      />
    );
  return <McpRequestsContent owner={owner} />;
}

function McpRequestsContent({ owner }: { owner: FeatureReadOwner }): React.JSX.Element {
  const auth = useAuth();
  const refetchInterval = useRefreshInterval();
  const [params, updateParams] = useSearchState();
  const [searchError, setSearchError] = useState<string | undefined>();
  const tableRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement>(null);

  const server = params.get("server") ?? "";
  const tool = params.get("tool") ?? "";
  const errorsOnly = params.get("errors") === "1";
  const requestId = params.get("request_id") ?? "";

  const { requests, waterfall, agentic } = useMcpRequestData(
    owner,
    {
      ...(server ? { server } : {}),
      ...(tool ? { tool } : {}),
      ...(errorsOnly ? { errors: "1" as const } : {}),
      limit: 50,
    },
    requestId,
    refetchInterval,
  );

  const applyFilters = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const nextServer = String(data.get("server") ?? "").trim();
    const nextTool = String(data.get("tool") ?? "").trim();
    if (
      containsPotentialSecret(nextServer, auth.credentialPrefixes) ||
      containsPotentialSecret(nextTool, auth.credentialPrefixes)
    ) {
      setSearchError(secretSearchMessage);
      const name = containsPotentialSecret(nextServer, auth.credentialPrefixes) ? "server" : "tool";
      event.currentTarget.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.focus();
      return;
    }
    setSearchError(undefined);
    updateParams({
      server: nextServer || undefined,
      tool: nextTool || undefined,
      errors: data.get("errors") === "on" ? "1" : undefined,
      request_id: undefined,
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
            <input
              id="mcp-req-errors"
              name="errors"
              type="checkbox"
              defaultChecked={errorsOnly}
              key={String(errorsOnly)}
            />
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
              onClick={(event) => {
                event.currentTarget.form?.reset();
                setSearchError(undefined);
                updateParams({
                  server: undefined,
                  tool: undefined,
                  errors: undefined,
                  request_id: undefined,
                });
              }}
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

      <div ref={tableRef} tabIndex={-1} aria-label="최근 MCP 요청 목록">
        <SectionCard
          title="최근 MCP 호출"
          description="조건에 맞는 최근 최대 50건입니다. 전체 보관 기록의 건수가 아닙니다. 행의 상세 버튼으로 처리 흐름과 도구 호출을 확인하세요."
        >
          {requests.isSuccess && rows.length === 0 ? (
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
              error={requests.isError && !requests.data ? "MCP 요청 로그를 불러오지 못했습니다." : undefined}
              getRowId={(row) => row.id}
              getRowActionLabel={(row) => `${row.id} 처리 흐름 열기`}
              onRowClick={(row) => {
                const active = document.activeElement;
                returnFocusRef.current =
                  active instanceof HTMLElement && tableRef.current?.contains(active)
                    ? active
                    : tableRef.current;
                updateParams({ request_id: row.id });
              }}
            />
          )}
        </SectionCard>
      </div>

      <Sheet
        open={requestId !== ""}
        onOpenChange={(open) => {
          if (!open) updateParams({ request_id: undefined });
        }}
        returnFocusRef={returnFocusRef}
        size="wide"
        title="MCP 요청 처리 흐름"
        description="저장된 요청·도구 기록과 현재 정책으로 재구성한 요약입니다."
      >
        <InlineNotice tone="info" title="호출 당시의 정책 기록과 구분하세요.">
          처리 단계의 정책·최종 조치는 조회 시점의 현재 설정입니다. 호출 당시 적용된 정책이나 실제 단계별 소요
          시간을 나타내지 않습니다.
        </InlineNotice>
        {waterfall.isError ? (
          <QueryNotice
            error={waterfall.error}
            hasData={Boolean(waterfall.data)}
            label="처리 흐름"
            onRetry={() => void waterfall.refetch()}
          />
        ) : null}
        {agentic.isError ? (
          <QueryNotice
            error={agentic.error}
            hasData={Boolean(agentic.data)}
            label="에이전트 실행 기록"
            onRetry={() => void agentic.refetch()}
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
              label: "에이전트 실행",
              value: agentic.data
                ? agentic.data.agentic
                  ? "기록 있음"
                  : "기록 없음"
                : agentic.isPending
                  ? "조회 중"
                  : "확인 불가",
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
            error={waterfall.isError && !waterfall.data ? "처리 단계를 불러오지 못했습니다." : undefined}
            getRowId={(row, index) => `${row.name}:${index}`}
          />
        </SectionCard>

        <SectionCard headingLevel={3} title="도구 호출">
          <DataTable
            caption="요청의 도구 호출"
            columns={invocationColumns}
            data={waterfall.data?.tools ?? []}
            loading={waterfall.isPending}
            error={waterfall.isError && !waterfall.data ? "도구 호출을 불러오지 못했습니다." : undefined}
            getRowId={(row, index) => `${row.server_label}:${row.tool_name}:${index}`}
            emptyMessage="도구 호출이 없습니다."
          />
        </SectionCard>
      </Sheet>
    </div>
  );
}
