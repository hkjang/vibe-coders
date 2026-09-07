import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import { withPathParams } from "@/features/agents/endpoint-path";
import { WorkflowDetailSheet } from "@/features/agents/workflows/WorkflowDetailSheet";
import { WorkflowFormDialog } from "@/features/agents/workflows/WorkflowFormDialog";
import { WorkflowReceiptDialog } from "@/features/agents/workflows/WorkflowReceiptDialog";
import {
  matchesWorkflowQuery,
  workflowUpsertBody,
  type WorkflowFormOutput,
} from "@/features/agents/workflows/workflow-form";
import { apiClient } from "@/shared/api/client";
import type { Workflow, WorkflowDryRun, WorkflowRun } from "@/shared/api/domains/agents.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { ErrorState, LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Tabs, TabPanel } from "@/shared/components/ui/Tabs";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import type { DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { displayColumn } from "@/features/agents/table-columns";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { formatDateTime, formatDuration, formatNumber } from "@/shared/utils/format";
import "@/features/agents/agents.css";

const tabIds = ["list", "runs"] as const;
type TabId = (typeof tabIds)[number];
const workflowsKey = ["agents", "workflows"] as const;
const writeScope = "admin:write";
const writeDisabledReason = "워크플로를 변경하려면 admin:write 권한이 필요합니다.";
const statusFilters = [
  { value: "all", label: "전체 상태" },
  { value: "enabled", label: "사용" },
  { value: "disabled", label: "중지" },
];

function statusTone(status: string | undefined): "danger" | "info" | "muted" | "success" | "warning" {
  switch (status) {
    case "ok":
      return "success";
    case "error":
      return "danger";
    case "pending_approval":
      return "warning";
    case "planned":
      return "info";
    default:
      return "muted";
  }
}

export function WorkflowPage(): React.JSX.Element {
  const auth = useAuth();
  const canWrite = auth.user?.scopes.includes(writeScope) ?? false;
  const [tab, setTab] = useTabParam<TabId>([...tabIds]);
  const [params, updateSearch] = useSearchState();
  const refreshInterval = useRefreshInterval();
  const rawQuery = params.get("q") ?? "";
  const query = containsPotentialSecret(rawQuery) ? "" : rawQuery;
  const status = params.get("status") ?? "all";
  const selectedId = params.get("workflow") ?? "";
  const [searchError, setSearchError] = useState<string | undefined>(
    containsPotentialSecret(rawQuery) ? secretSearchMessage : undefined,
  );
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Workflow | undefined>();
  const [publishTarget, setPublishTarget] = useState<Workflow | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<Workflow | undefined>();
  const [dryRunResult, setDryRunResult] = useState<WorkflowDryRun | undefined>();
  const [receiptRunId, setReceiptRunId] = useState("");
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const rowTriggerRef = useRef<HTMLElement | null>(null);
  const dialogReturnRef = useRef<HTMLElement | null>(null);

  const list = useQuery({
    queryKey: workflowsKey,
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.agents.workflows.list, {
        signal,
        routeId: "agents.workflows",
      }),
    refetchInterval: refreshInterval,
    refetchIntervalInBackground: false,
  });

  const runs = useQuery({
    queryKey: [...workflowsKey, "runs"],
    enabled: tab === "runs",
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.agents.workflows.runs, {
        query: { limit: 50 },
        signal,
        routeId: "agents.workflows",
      }),
  });

  const workflows = useMemo(() => list.data?.workflows ?? [], [list.data?.workflows]);
  const rows = useMemo(
    () =>
      workflows.filter(
        (workflow) =>
          matchesWorkflowQuery(workflow, query) &&
          (status === "all" ||
            (status === "enabled" && workflow.enabled === true) ||
            (status === "disabled" && workflow.enabled !== true)),
      ),
    [query, status, workflows],
  );
  const selected = workflows.find((workflow) => workflow.id === selectedId);

  const closeSheet = useCallback((): void => {
    setDryRunResult(undefined);
    updateSearch({ workflow: undefined });
  }, [updateSearch]);

  const upsert = useMutationFeedback({
    mutate: (variables: { values: WorkflowFormOutput; id?: string }) =>
      apiClient.request(endpoints.domains.agents.workflows.upsert, {
        body: workflowUpsertBody(variables.values, variables.id),
        routeId: "agents.workflows",
      }),
    invalidates: [workflowsKey],
    successMessage: "워크플로를 저장했습니다.",
    errorMessage: "워크플로를 저장하지 못했습니다.",
  });

  const remove = useMutationFeedback({
    mutate: (id: string) =>
      apiClient.request(endpoints.domains.agents.workflows.remove, {
        query: { id },
        routeId: "agents.workflows",
      }),
    invalidates: [workflowsKey],
    successMessage: "워크플로를 삭제했습니다.",
    errorMessage: "워크플로를 삭제하지 못했습니다.",
    onSuccess: () => closeSheet(),
  });

  const publish = useMutationFeedback({
    mutate: (variables: { id: string; note: string }) =>
      apiClient.request(withPathParams(endpoints.domains.agents.workflows.publish, { id: variables.id }), {
        body: { note: variables.note },
        routeId: "agents.workflows",
      }),
    invalidates: [workflowsKey],
    successMessage: (result) => `워크플로를 게시했습니다. (v${formatNumber(result.version ?? 0)})`,
    errorMessage: "워크플로를 게시하지 못했습니다.",
  });

  const dryRun = useMutation({
    mutationFn: (id: string) =>
      apiClient.request(withPathParams(endpoints.domains.agents.workflows.dryRun, { id }), {
        routeId: "agents.workflows",
      }),
    onSuccess: (result) => setDryRunResult(result),
  });

  const columns = useMemo<ReadonlyArray<DataTableColumn<Workflow>>>(
    () => [
      displayColumn<Workflow>("name", "이름", (row) => (
        <span className="truncate">{row.name ?? row.id}</span>
      )),
      displayColumn<Workflow>("steps", "단계", (row) => (
        <span className="cell-number">{formatNumber(row.steps?.length ?? 0)}</span>
      )),
      displayColumn<Workflow>("teams", "허용 팀", (row) => row.allowed_teams || "전체"),
      displayColumn<Workflow>("enabled", "상태", (row) => (
        <Badge tone={row.enabled ? "success" : "muted"}>{row.enabled ? "사용" : "중지"}</Badge>
      )),
      displayColumn<Workflow>("updated_at", "수정일", (row) => formatDateTime(row.updated_at)),
    ],
    [],
  );

  const runColumns = useMemo<ReadonlyArray<DataTableColumn<WorkflowRun>>>(
    () => [
      displayColumn<WorkflowRun>("created_at", "실행 시각", (row) => formatDateTime(row.created_at)),
      displayColumn<WorkflowRun>(
        "workflow",
        "워크플로",
        (row) =>
          workflows.find((workflow) => workflow.id === row.workflow_id)?.name ?? row.workflow_id ?? "—",
      ),
      displayColumn<WorkflowRun>("status", "상태", (row) => (
        <Badge tone={statusTone(row.status)}>{row.status || "—"}</Badge>
      )),
      displayColumn<WorkflowRun>(
        "steps",
        "단계 성공",
        (row) => `${formatNumber(row.steps_ok ?? 0)}/${formatNumber(row.steps_total ?? 0)}`,
      ),
      displayColumn<WorkflowRun>("latency", "소요", (row) => (
        <span className="cell-number">{formatDuration(row.latency_ms ?? 0)}</span>
      )),
      displayColumn<WorkflowRun>("error", "오류 분류", (row) => row.error_class || "—"),
    ],
    [workflows],
  );

  const enabledCount = workflows.filter((workflow) => workflow.enabled === true).length;
  const stepTotal = workflows.reduce((total, workflow) => total + (workflow.steps?.length ?? 0), 0);
  const summaryUnavailable = list.isPending || (list.isError && !list.data);

  if (list.isPending && !list.data) {
    return (
      <div className="page-stack">
        <PageHeader
          title="워크플로"
          description="여러 단계를 묶어 업무를 자동화하는 워크플로 체인을 정의하고 검증·게시합니다."
          legacyHref="/admin#/workflows"
        />
        <LoadingState label="워크플로 목록을 불러오는 중입니다." />
      </div>
    );
  }

  if (list.isError && !list.data) {
    return (
      <div className="page-stack">
        <PageHeader
          title="워크플로"
          description="여러 단계를 묶어 업무를 자동화하는 워크플로 체인을 정의하고 검증·게시합니다."
          legacyHref="/admin#/workflows"
        />
        <ErrorState
          message={safeAppErrorMessage(list.error, "워크플로 목록을 불러오지 못했습니다.")}
          requestId={isAppError(list.error) ? list.error.requestId : undefined}
          onRetry={() => void list.refetch()}
          legacyHref="/admin#/workflows"
        />
      </div>
    );
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="워크플로"
        description="여러 단계를 묶어 업무를 자동화하는 워크플로 체인을 정의하고 검증·게시합니다."
        legacyHref="/admin#/workflows"
        actions={
          <>
            <Button onClick={() => void list.refetch()} disabled={list.isFetching}>
              <RefreshCw aria-hidden="true" /> {list.isFetching ? "갱신 중" : "새로고침"}
            </Button>
            <Button
              ref={createButtonRef}
              variant="primary"
              disabled={!canWrite}
              title={canWrite ? undefined : writeDisabledReason}
              onClick={() => {
                setEditing(undefined);
                dialogReturnRef.current = createButtonRef.current;
                setFormOpen(true);
              }}
            >
              <Plus aria-hidden="true" /> 새 워크플로
            </Button>
          </>
        }
      />

      <StatGrid label="워크플로 요약">
        <StatCard label="전체 워크플로" value={summaryUnavailable ? "—" : formatNumber(workflows.length)} />
        <StatCard
          label="사용 중"
          tone="success"
          value={summaryUnavailable ? "—" : formatNumber(enabledCount)}
        />
        <StatCard label="총 단계" value={summaryUnavailable ? "—" : formatNumber(stepTotal)} />
        <StatCard
          label="최근 실행"
          value={runs.data ? formatNumber(runs.data.runs?.length ?? 0) : "—"}
          hint="내 실행 이력 기준"
        />
      </StatGrid>

      {list.isError && list.data ? (
        <InlineNotice
          tone="warning"
          title="목록을 갱신하지 못했습니다."
          actions={
            <Button size="small" onClick={() => void list.refetch()}>
              다시 시도
            </Button>
          }
        >
          마지막으로 확인한 목록을 표시합니다.
        </InlineNotice>
      ) : null}

      <Tabs
        ariaLabel="워크플로 화면"
        items={[
          { id: "list", label: "워크플로", badge: formatNumber(workflows.length) },
          { id: "runs", label: "실행 이력" },
        ]}
        onChange={setTab}
        panelIdPrefix="workflows"
        value={tab}
      />

      {tab === "list" ? (
        <TabPanel id="list" panelIdPrefix="workflows">
          <Toolbar label="워크플로 필터">
            <form
              className="agents-toolbar-field"
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                const submitted = new FormData(event.currentTarget).get("q");
                const next = typeof submitted === "string" ? submitted.trim() : "";
                if (containsPotentialSecret(next)) {
                  setSearchError(secretSearchMessage);
                  return;
                }
                setSearchError(undefined);
                updateSearch({ q: next || undefined });
              }}
            >
              <label htmlFor="workflow-search">워크플로 검색</label>
              <Input
                id="workflow-search"
                key={query}
                name="q"
                defaultValue={query}
                placeholder="이름, 설명, 팀"
                aria-invalid={searchError ? "true" : undefined}
                aria-describedby={searchError ? "workflow-search-error" : undefined}
              />
              {searchError ? (
                <span id="workflow-search-error" className="field-error" role="alert">
                  {searchError}
                </span>
              ) : null}
            </form>
            <label className="agents-toolbar-field" htmlFor="workflow-status">
              <span>상태</span>
              <Select
                id="workflow-status"
                value={status}
                options={statusFilters}
                onChange={(event) =>
                  updateSearch({ status: event.target.value === "all" ? undefined : event.target.value })
                }
              />
            </label>
          </Toolbar>

          {workflows.length === 0 ? (
            <EmptyState
              title="아직 워크플로가 없습니다."
              description="단계를 묶어 워크플로를 만들면 여기에서 검증하고 게시할 수 있습니다."
              actions={
                <Button
                  variant="primary"
                  disabled={!canWrite}
                  title={canWrite ? undefined : writeDisabledReason}
                  onClick={() => {
                    setEditing(undefined);
                    setFormOpen(true);
                  }}
                >
                  새 워크플로
                </Button>
              }
            />
          ) : (
            <DataTable
              caption="정의된 워크플로 목록"
              columns={columns}
              data={rows}
              emptyMessage="조건에 맞는 워크플로가 없습니다."
              getRowId={(row) => row.id}
              getRowActionLabel={(row) => `${row.name ?? row.id} 상세 열기`}
              loading={list.isFetching && !list.data}
              onRowClick={(row) => {
                rowTriggerRef.current = document.activeElement as HTMLElement | null;
                setDryRunResult(undefined);
                updateSearch({ workflow: row.id });
              }}
            />
          )}
          <p className="agents-updated">마지막 갱신 {formatDateTime(list.dataUpdatedAt)}</p>
        </TabPanel>
      ) : (
        <TabPanel id="runs" panelIdPrefix="workflows">
          <p>
            내 계정이 실행한 워크플로의 영수증입니다. 단계 상태와 소요만 남으며 원문 입력·출력은 저장되지
            않습니다.
          </p>
          {runs.isError ? (
            <InlineNotice
              tone="danger"
              title="실행 이력을 불러오지 못했습니다."
              actions={
                <Button size="small" onClick={() => void runs.refetch()}>
                  다시 시도
                </Button>
              }
            >
              {safeAppErrorMessage(runs.error, "실행 이력을 불러오지 못했습니다.")}
            </InlineNotice>
          ) : null}
          <DataTable
            caption="내 워크플로 실행 이력"
            columns={runColumns}
            data={runs.data?.runs ?? []}
            emptyMessage="아직 실행한 워크플로가 없습니다."
            getRowId={(row) => row.id}
            getRowActionLabel={(row) => `실행 ${row.id} 영수증 열기`}
            loading={runs.isPending}
            onRowClick={(row) => {
              rowTriggerRef.current = document.activeElement as HTMLElement | null;
              setReceiptRunId(row.id);
            }}
          />
        </TabPanel>
      )}

      <WorkflowReceiptDialog
        onOpenChange={(open) => {
          if (!open) setReceiptRunId("");
        }}
        returnFocusRef={rowTriggerRef}
        runId={receiptRunId}
      />

      <WorkflowDetailSheet
        canWrite={canWrite}
        dryRun={dryRunResult}
        dryRunError={dryRun.error}
        dryRunPending={dryRun.isPending}
        onDelete={() => setDeleteTarget(selected)}
        onDryRun={() => {
          if (selected) dryRun.mutate(selected.id);
        }}
        onEdit={() => {
          setEditing(selected);
          setFormOpen(true);
        }}
        onOpenChange={(open) => {
          if (!open) closeSheet();
        }}
        onPublish={() => setPublishTarget(selected)}
        open={selectedId !== ""}
        returnFocusRef={rowTriggerRef}
        workflow={selected}
        writeDisabledReason={writeDisabledReason}
      />

      <WorkflowFormDialog
        onOpenChange={setFormOpen}
        onSubmit={async (values) => {
          await upsert.mutateAsync({ values, id: editing?.id });
        }}
        open={formOpen}
        returnFocusRef={dialogReturnRef}
        workflow={editing}
      />

      <ConfirmDialog
        title="워크플로 게시"
        description={`'${publishTarget?.name ?? ""}' 워크플로의 현재 정의를 새 버전으로 게시합니다. 검증에 실패한 단계가 있으면 게시되지 않습니다.`}
        confirmLabel="게시"
        requireReason
        open={publishTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setPublishTarget(undefined);
        }}
        onConfirm={async (reason) => {
          if (publishTarget) await publish.mutateAsync({ id: publishTarget.id, note: reason });
        }}
        returnFocusRef={rowTriggerRef}
      />

      <ConfirmDialog
        title="워크플로 삭제"
        description={`'${deleteTarget?.name ?? ""}' 워크플로를 삭제합니다. 이 작업은 되돌릴 수 없습니다.`}
        confirmLabel="삭제"
        tone="danger"
        open={deleteTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(undefined);
        }}
        onConfirm={async () => {
          if (deleteTarget) await remove.mutateAsync(deleteTarget.id);
        }}
        returnFocusRef={rowTriggerRef}
      />
    </div>
  );
}
