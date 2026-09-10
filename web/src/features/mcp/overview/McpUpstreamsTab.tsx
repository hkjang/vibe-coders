import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useRef, useState } from "react";

import { QueryNotice } from "@/features/mcp/mcp-ui";
import {
  decisionLabel,
  decisionTone,
  detailText,
  listToCsv,
  riskTone,
  stepTone,
} from "@/features/mcp/mcp-utils";
import { UpstreamFormDialog } from "@/features/mcp/overview/UpstreamFormDialog";
import { apiClient } from "@/shared/api/client";
import { isAppError } from "@/shared/api/error";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import type { McpDiscoveryRun, McpRequest, McpFlowStep, McpUpstream } from "@/shared/api/domains/mcp.schemas";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Sheet } from "@/shared/components/ui/Sheet";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

const routeId = "mcp.overview";
const column = createDataTableColumnHelper<McpUpstream>();

function upstreamColumns(
  discoveryErrors: Readonly<Record<string, string>>,
): ReadonlyArray<DataTableColumn<McpUpstream>> {
  return [
    column.accessor((row) => row.name, {
      id: "name",
      header: "이름",
      cell: (info) => (
        <div>
          <strong>{info.getValue<string>() || "—"}</strong>
          <div className="mono">{info.row.original.id}</div>
        </div>
      ),
    }),
    column.accessor((row) => row.url, {
      id: "url",
      header: "엔드포인트",
      cell: (info) => <span className="mono truncate">{info.getValue<string>() || "—"}</span>,
    }),
    column.accessor((row) => row.enabled, {
      id: "enabled",
      header: "상태",
      cell: (info) =>
        info.getValue<boolean>() ? <Badge tone="success">사용</Badge> : <Badge tone="muted">중지</Badge>,
    }),
    column.accessor((row) => row.has_auth, {
      id: "auth",
      header: "인증",
      cell: (info) => (info.getValue<boolean>() ? "토큰 설정됨" : "없음"),
    }),
    column.accessor((row) => row.metadata?.risk_level ?? "", {
      id: "risk",
      header: "위험도",
      cell: (info) =>
        info.getValue<string>() ? (
          <Badge tone={riskTone(info.getValue<string>())}>{info.getValue<string>()}</Badge>
        ) : (
          "—"
        ),
    }),
    column.accessor((row) => row.metadata?.requires_approval ?? false, {
      id: "approval",
      header: "승인 게이트",
      cell: (info) => (info.getValue<boolean>() ? "필요" : "—"),
    }),
    column.accessor((row) => discoveryErrors[row.name] ?? "", {
      id: "discovery",
      header: "디스커버리",
      cell: (info) =>
        info.getValue<string>() ? <Badge tone="danger">오류</Badge> : <Badge tone="success">정상</Badge>,
    }),
  ] as ReadonlyArray<DataTableColumn<McpUpstream>>;
}

const stepColumn = createDataTableColumnHelper<McpFlowStep>();
const stepColumns = [
  stepColumn.accessor((row) => row.name, { id: "name", header: "단계" }),
  stepColumn.accessor((row) => detailText(row.status), {
    id: "status",
    header: "상태",
    cell: (info) => <Badge tone={stepTone(info.getValue<string>())}>{info.getValue<string>()}</Badge>,
  }),
  stepColumn.accessor((row) => detailText(row.detail), { id: "detail", header: "내용" }),
] as ReadonlyArray<DataTableColumn<McpFlowStep>>;

const runColumn = createDataTableColumnHelper<McpDiscoveryRun>();
const runColumns = [
  runColumn.accessor((row) => formatDateTime(row.created_at), { id: "created_at", header: "시각" }),
  runColumn.accessor((row) => row.status, { id: "status", header: "상태" }),
  runColumn.accessor((row) => formatNumber(row.tool_count), { id: "tools", header: "도구" }),
  runColumn.accessor((row) => `${formatNumber(row.latency_ms)}ms`, { id: "latency", header: "지연" }),
  runColumn.accessor((row) => row.error || "—", { id: "error", header: "오류" }),
] as ReadonlyArray<DataTableColumn<McpDiscoveryRun>>;

const callColumn = createDataTableColumnHelper<McpRequest>();
const callColumns = [
  callColumn.accessor((row) => formatDateTime(row.created_at), { id: "created_at", header: "시각" }),
  callColumn.accessor((row) => row.id, {
    id: "id",
    header: "요청 ID",
    cell: (info) => <span className="mono">{info.getValue<string>()}</span>,
  }),
  callColumn.accessor((row) => row.model || "—", { id: "model", header: "모델" }),
  callColumn.accessor((row) => formatNumber(row.status_code), { id: "status", header: "상태" }),
] as ReadonlyArray<DataTableColumn<McpRequest>>;

export function McpUpstreamsTab({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const refetchInterval = useRefreshInterval();
  const [params, updateParams] = useSearchState();
  const selectedId = params.get("upstream") ?? "";
  const [formOpen, setFormOpen] = useState(false);
  const [formInstance, setFormInstance] = useState(0);
  const [editing, setEditing] = useState<McpUpstream | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<McpUpstream | undefined>();
  const [toggleTarget, setToggleTarget] = useState<McpUpstream | undefined>();
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const detailReturnRef = useRef<HTMLElement>(null);

  const upstreams = useQuery({
    queryKey: ["mcp", "upstreams"],
    queryFn: ({ signal }) => apiClient.request(endpoints.domains.mcp.upstreams, { signal, routeId }),
    refetchInterval,
    refetchIntervalInBackground: false,
  });
  const flow = useQuery({
    queryKey: ["mcp", "upstreams", selectedId, "flow"],
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(endpoints.domains.mcp.upstreamFlow, { id: selectedId }), {
        signal,
        routeId,
      }),
    enabled: selectedId !== "",
  });

  const remove = useMutationFeedback({
    mutate: (id: string) =>
      apiClient.request(withPathParams(endpoints.domains.mcp.deleteUpstream, { id }), { routeId }),
    invalidates: [["mcp"]],
    successMessage: "업스트림을 삭제했습니다.",
    errorMessage: "업스트림을 삭제하지 못했습니다.",
  });
  // POST .../probe forces a fresh handshake and records a discovery run, so it is the
  // real "is this registration working, and what does it expose?" check.
  const probe = useMutationFeedback({
    mutate: (id: string) =>
      apiClient.request(withPathParams(endpoints.domains.mcp.probeUpstream, { id }), { routeId }),
    invalidates: [["mcp"]],
    successMessage: (result) =>
      result.ok
        ? `연결에 성공했습니다. 도구 ${formatNumber(result.tool_count)}개를 찾았습니다.`
        : "연결 진단이 실패했습니다.",
    errorMessage: "연결 진단을 실행하지 못했습니다.",
  });
  const toggleEnabled = useMutationFeedback({
    mutate: (variables: { enabled: boolean; id: string }) =>
      apiClient.request(withPathParams(endpoints.domains.mcp.patchUpstream, { id: variables.id }), {
        body: { enabled: variables.enabled },
        routeId,
      }),
    invalidates: [["mcp"]],
    successMessage: (_result, variables) =>
      variables.enabled ? "업스트림을 사용 상태로 바꿨습니다." : "업스트림 사용을 중지했습니다.",
    errorMessage: "업스트림 사용 상태를 바꾸지 못했습니다.",
  });

  const rows = upstreams.data?.upstreams ?? [];
  const discoveryErrors = upstreams.data?.discovery_errors ?? {};
  const selected = rows.find((row) => row.id === selectedId);
  const flowFinal = flow.data?.final;

  const closeDetail = (): void => updateParams({ upstream: undefined });

  return (
    <div className="mcp-section-stack">
      {upstreams.isError ? (
        <QueryNotice
          error={upstreams.error}
          hasData={Boolean(upstreams.data)}
          label="업스트림 목록"
          onRetry={() => void upstreams.refetch()}
        />
      ) : null}

      <Toolbar
        label="업스트림 작업"
        end={
          <Button
            ref={createButtonRef}
            variant="primary"
            disabled={!canWrite}
            title={canWrite ? undefined : "mcp:admin 권한이 필요합니다."}
            onClick={() => {
              setEditing(undefined);
              setFormInstance((value) => value + 1);
              setFormOpen(true);
            }}
          >
            <Plus aria-hidden="true" /> 업스트림 등록
          </Button>
        }
      >
        <span className="mcp-note">
          등록 {formatNumber(rows.length)}개 · 사용 중{" "}
          {formatNumber(rows.filter((row) => row.enabled).length)}개
        </span>
      </Toolbar>

      {Object.entries(discoveryErrors).map(([upstream, message]) => (
        <InlineNotice key={upstream} tone="warning" title={`${upstream} 도구 디스커버리 오류`}>
          <p className="mono">{message}</p>
        </InlineNotice>
      ))}

      {!upstreams.isPending && rows.length === 0 ? (
        <EmptyState
          title="등록된 MCP 업스트림이 없습니다."
          description="MCP 서버를 등록하면 게이트웨이가 도구를 모아 하나의 /mcp 엔드포인트로 노출합니다."
          actions={
            <Button
              variant="primary"
              disabled={!canWrite}
              onClick={() => {
                setEditing(undefined);
                setFormInstance((value) => value + 1);
                setFormOpen(true);
              }}
            >
              업스트림 등록
            </Button>
          }
        />
      ) : (
        <DataTable
          caption="등록된 MCP 업스트림"
          columns={upstreamColumns(discoveryErrors)}
          data={rows}
          getRowId={(row) => row.id}
          loading={upstreams.isPending}
          getRowActionLabel={(row) => `${row.name} 상세 열기`}
          onRowClick={(row) => updateParams({ upstream: row.id })}
        />
      )}

      <UpstreamFormDialog
        key={`upstream-form-${formInstance}`}
        canWrite={canWrite}
        open={formOpen}
        onOpenChange={setFormOpen}
        returnFocusRef={createButtonRef}
        upstream={editing}
      />

      <ConfirmDialog
        open={deleteTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(undefined);
        }}
        returnFocusRef={detailReturnRef}
        tone="danger"
        title="업스트림을 삭제할까요?"
        description={`${deleteTarget?.name ?? ""} 업스트림과 노출 중인 도구가 즉시 사라집니다.`}
        confirmLabel="삭제"
        onConfirm={async () => {
          if (!deleteTarget) return;
          await remove.mutateAsync(deleteTarget.id);
          setDeleteTarget(undefined);
          closeDetail();
        }}
      />

      <ConfirmDialog
        open={toggleTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setToggleTarget(undefined);
        }}
        returnFocusRef={detailReturnRef}
        tone={toggleTarget?.enabled ? "danger" : "primary"}
        title={toggleTarget?.enabled ? "업스트림 사용을 중지할까요?" : "업스트림을 사용할까요?"}
        description={
          toggleTarget?.enabled
            ? `${toggleTarget.name} 업스트림의 도구가 게이트웨이 /mcp 목록에서 즉시 빠집니다.`
            : `${toggleTarget?.name ?? ""} 업스트림의 도구가 게이트웨이 /mcp 목록에 즉시 노출됩니다.`
        }
        confirmLabel={toggleTarget?.enabled ? "사용 중지" : "사용 시작"}
        onConfirm={async () => {
          if (!toggleTarget) return;
          await toggleEnabled.mutateAsync({ enabled: !toggleTarget.enabled, id: toggleTarget.id });
          setToggleTarget(undefined);
        }}
      >
        {toggleTarget?.enabled ? null : (
          <p>
            부분 수정은 온보딩 필수 항목을 다시 확인하지 않습니다. 위험 등급과 승인 게이트를 먼저 점검하세요.
          </p>
        )}
      </ConfirmDialog>

      <Sheet
        open={selectedId !== ""}
        onOpenChange={(open) => {
          if (!open) closeDetail();
        }}
        returnFocusRef={detailReturnRef}
        size="wide"
        title={selected?.name || selectedId}
        description="업스트림 연결 흐름, 노출 라우트와 최근 호출을 확인합니다."
        footer={
          <>
            <Button
              disabled={!canWrite || probe.isPending || !selected}
              title={canWrite ? undefined : "mcp:admin 권한이 필요합니다."}
              onClick={() => selected && probe.mutate(selected.id)}
            >
              {probe.isPending ? "확인 중" : "연결 진단"}
            </Button>
            <Button
              disabled={!canWrite || !selected}
              title={canWrite ? undefined : "mcp:admin 권한이 필요합니다."}
              onClick={() => setToggleTarget(selected)}
            >
              {selected?.enabled ? "사용 중지" : "사용 시작"}
            </Button>
            <Button
              disabled={!canWrite || !selected}
              onClick={() => {
                setEditing(selected);
                setFormInstance((value) => value + 1);
                setFormOpen(true);
              }}
            >
              수정
            </Button>
            <Button
              variant="danger"
              disabled={!canWrite || !selected}
              onClick={() => setDeleteTarget(selected)}
            >
              삭제
            </Button>
          </>
        }
      >
        {flow.isError ? (
          <QueryNotice
            error={flow.error}
            hasData={Boolean(flow.data)}
            label="업스트림 흐름"
            onRetry={() => void flow.refetch()}
          />
        ) : null}
        <KeyValueList
          items={[
            { label: "업스트림 ID", value: selected?.id ?? selectedId, mono: true },
            { label: "엔드포인트", value: selected?.url ?? "—", mono: true },
            { label: "상태", value: selected?.enabled ? "사용" : "중지" },
            { label: "인증 토큰", value: selected?.has_auth ? "설정됨" : "없음" },
            { label: "위험도", value: selected?.metadata?.risk_level || "—" },
            { label: "승인 게이트", value: selected?.metadata?.requires_approval ? "필요" : "—" },
            { label: "설명", value: selected?.metadata?.description || "—" },
            { label: "도메인", value: listToCsv(selected?.metadata?.domains) || "—" },
            {
              label: "정책 판단",
              value: flowFinal ? (
                <Badge tone={decisionTone(flowFinal.decision)}>{decisionLabel(flowFinal.decision)}</Badge>
              ) : (
                "—"
              ),
            },
            { label: "판단 근거", value: flowFinal?.reason || "—" },
            { label: "등록 시각", value: formatDateTime(selected?.created_at) },
          ]}
        />

        {probe.data ? (
          <InlineNotice
            tone={probe.data.ok ? "success" : "danger"}
            title={probe.data.ok ? "연결 정상" : "도구 디스커버리 실패"}
          >
            <p>
              도구 {formatNumber(probe.data.tool_count)}개 · 프롬프트 {formatNumber(probe.data.prompt_count)}
              개 · 리소스 {formatNumber(probe.data.resource_count)}개
            </p>
            {Object.entries(probe.data.errors).map(([capability, message]) => (
              <p key={capability} className="mono">
                {capability}: {message}
              </p>
            ))}
            {probe.data.tools.length > 0 ? (
              <p className="mono truncate">
                {probe.data.tools.map((discovered) => discovered.namespaced || discovered.name).join(", ")}
              </p>
            ) : null}
          </InlineNotice>
        ) : null}

        <SectionCard
          headingLevel={3}
          title="연결 단계"
          description="등록 → 사용 → 디스커버리 → 라우트 → 정책"
        >
          <DataTable
            caption="업스트림 연결 단계"
            columns={stepColumns}
            data={flow.data?.steps ?? []}
            loading={flow.isPending}
            getRowId={(row, index) => `${row.name}:${index}`}
          />
        </SectionCard>

        <SectionCard headingLevel={3} title="최근 디스커버리 실행">
          <DataTable
            caption="업스트림 디스커버리 실행 이력"
            columns={runColumns}
            data={flow.data?.discovery_runs ?? []}
            getRowId={(row, index) => row.id || String(index)}
            emptyMessage="디스커버리 실행 기록이 없습니다."
          />
        </SectionCard>

        <SectionCard headingLevel={3} title="최근 MCP 호출">
          <DataTable
            caption="업스트림 최근 호출"
            columns={callColumns}
            data={flow.data?.recent_requests ?? []}
            getRowId={(row, index) => row.id || String(index)}
            emptyMessage="최근 호출이 없습니다."
          />
        </SectionCard>

        {flow.data?.discovery_error ? (
          <InlineNotice tone="danger" title="디스커버리 오류">
            <p className="mono">{flow.data.discovery_error}</p>
          </InlineNotice>
        ) : null}
        {isAppError(flow.error) && flow.error.status === 404 ? (
          <InlineNotice tone="warning" title="업스트림을 찾을 수 없습니다.">
            이미 삭제되었을 수 있습니다. 목록을 새로고침하세요.
          </InlineNotice>
        ) : null}
      </Sheet>
    </div>
  );
}
