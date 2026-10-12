import { useQuery } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import {
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import { useWorkflowMutations, workflowsKey } from "./use-workflow-mutations";
import { useWorkflowColumns } from "./workflow-tables";
import { WorkflowDetailSheet } from "@/features/agents/workflows/WorkflowDetailSheet";
import { WorkflowFormDialog } from "@/features/agents/workflows/WorkflowFormDialog";
import { WorkflowReceiptDialog } from "@/features/agents/workflows/WorkflowReceiptDialog";
import { matchesWorkflowQuery } from "@/features/agents/workflows/workflow-form";
import { apiClient } from "@/shared/api/client";
import type { Workflow } from "@/shared/api/domains/agents.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { ErrorState, LoadingState } from "@/shared/components/state/PageStates";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Tabs, TabPanel } from "@/shared/components/ui/Tabs";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { DataTable } from "@/shared/data-table/DataTable";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { tokenStore } from "@/shared/auth/token-store";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import "@/features/agents/agents.css";

const tabIds = ["list", "runs"] as const;
type TabId = (typeof tabIds)[number];
const writeScope = "admin:write";
const scopeWriteDisabledReason = "워크플로를 변경하려면 admin:write 권한이 필요합니다.";
const statusFilters = [
  { value: "all", label: "전체 상태" },
  { value: "enabled", label: "사용" },
  { value: "disabled", label: "중지" },
];

export function WorkflowPage(): React.JSX.Element {
  const auth = useAuth();
  const context = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const owner = JSON.stringify([
    epoch,
    auth.mode,
    auth.user?.id,
    auth.user?.role,
    auth.user?.roles,
    auth.user?.team_id,
    context?.featureId,
    context?.permitted,
    auth.user?.scopes.includes("admin:read"),
  ]);
  return <WorkflowPageContent key={owner} />;
}

function WorkflowPageContent(): React.JSX.Element {
  const auth = useAuth();
  const alive = useRef(false);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const ownsResult = useCallback(() => alive.current, []);
  const mutationAccess = useFeatureMutationAccess(
    ["agents.workflows"],
    auth.user?.scopes.includes(writeScope) === true && auth.user.scopes.includes("admin:read"),
    scopeWriteDisabledReason,
  );
  const canWrite = mutationAccess.allowed;
  const writeDisabledReason = mutationAccess.reason ?? scopeWriteDisabledReason;
  const [tab, setTab] = useTabParam<TabId>([...tabIds]);
  const [params, updateSearch] = useSearchState();
  const refreshInterval = useRefreshInterval();
  const rawQuery = params.get("q") ?? "";
  const query = containsPotentialSecret(rawQuery) ? "" : rawQuery;
  const status = params.get("status") ?? "all";
  const selectedId = params.get("workflow") ?? "";
  const currentSelection = useRef(selectedId);
  useLayoutEffect(() => {
    currentSelection.current = selectedId;
  }, [selectedId]);
  const [searchError, setSearchError] = useState<string | undefined>(
    containsPotentialSecret(rawQuery) ? secretSearchMessage : undefined,
  );
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Workflow | undefined>();
  const [publishTarget, setPublishTarget] = useState<Workflow | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<Workflow | undefined>();
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
    updateSearch({ workflow: undefined });
  }, [updateSearch]);

  const { upsert, remove, publish } = useWorkflowMutations({
    assertCurrent: mutationAccess.assertCurrent,
    ownsResult,
    onRemoved: (id) => {
      if (currentSelection.current === id) closeSheet();
    },
  });
  const { columns, runColumns } = useWorkflowColumns(workflows);

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
        key={JSON.stringify([selectedId, selected])}
        canWrite={canWrite}
        onDelete={() => setDeleteTarget(selected)}
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
        canWrite={canWrite}
        writeDisabledReason={writeDisabledReason}
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
        confirmDisabled={!canWrite}
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
        confirmDisabled={!canWrite}
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
