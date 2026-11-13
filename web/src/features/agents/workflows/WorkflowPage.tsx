import { useQuery } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import { useWorkflowMutations, workflowsKey } from "./use-workflow-mutations";
import { useWorkflowColumns } from "./workflow-tables";
import { WorkflowDetailSheet } from "@/features/agents/workflows/WorkflowDetailSheet";
import { WorkflowFormDialog } from "@/features/agents/workflows/WorkflowFormDialog";
import { WorkflowReceiptDialog } from "@/features/agents/workflows/WorkflowReceiptDialog";
import { apiClient } from "@/shared/api/client";
import type { Workflow } from "@/shared/api/domains/agents.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { ErrorState, PermissionDenied } from "@/shared/components/state/PageStates";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Tabs, TabPanel } from "@/shared/components/ui/Tabs";
import { DataTable } from "@/shared/data-table/DataTable";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import { formatNumber } from "@/shared/utils/format";
import {
  assertFeatureRead,
  featureOwnedKey,
  useFeatureReadOwner,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { useWorkflowPageQuery, useWorkflowDetailQuery } from "./use-workflow-queries";
import { readWorkflowPage, validWorkflowDetailId } from "./workflow-page-model";
import { WorkflowListPanel } from "./WorkflowListPanel";
import "@/features/agents/agents.css";

const tabIds = ["list", "runs"] as const;
type TabId = (typeof tabIds)[number];
const writeScope = "admin:write";
const scopeWriteDisabledReason = "워크플로를 변경하려면 admin:write 권한이 필요합니다.";
export function WorkflowPage(): React.JSX.Element {
  const owner = useFeatureReadOwner("agents.workflows", "workflow-management");
  if (!owner.readable) return <PermissionDenied permission="admin:read" />;
  if (owner.denied)
    return (
      <ErrorState
        message="워크플로 조회 권한이 없거나 인증 상태가 변경되었습니다. 권한을 확인하고 다시 조회하세요."
        onRetry={owner.restart}
        showLegacy={false}
      />
    );
  return <WorkflowPageContent key={owner.id} owner={owner} />;
}

function WorkflowPageContent({ owner }: { owner: FeatureReadOwner }): React.JSX.Element {
  const auth = useAuth();
  const alive = useRef(false);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const ownsResult = useCallback(() => alive.current && owner.isCurrent(), [owner]);
  const mutationAccess = useFeatureMutationAccess(
    ["agents.workflows"],
    auth.user?.scopes.includes(writeScope) === true && auth.user.scopes.includes("admin:read"),
    scopeWriteDisabledReason,
  );
  const canWrite = mutationAccess.allowed;
  const writeDisabledReason = mutationAccess.reason ?? scopeWriteDisabledReason;
  const [tab, setTab] = useTabParam<TabId>([...tabIds]);
  const [params, updateSearch] = useSearchState();
  const state = readWorkflowPage(params, auth.credentialPrefixes);
  const selectedId = params.get("workflow") ?? "";
  const selectedValid =
    params.getAll("workflow").length === 1 && validWorkflowDetailId(selectedId, auth.credentialPrefixes);
  const currentSelection = useRef(selectedId);
  useLayoutEffect(() => {
    currentSelection.current = selectedId;
  }, [selectedId]);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Workflow | undefined>();
  const [publishTarget, setPublishTarget] = useState<Workflow | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<Workflow | undefined>();
  const [receiptRunId, setReceiptRunId] = useState("");
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const rowTriggerRef = useRef<HTMLElement | null>(null);
  const dialogReturnRef = useRef<HTMLElement | null>(null);

  const list = useWorkflowPageQuery(state.query, owner);
  const detail = useWorkflowDetailQuery(selectedValid ? selectedId : undefined, owner);
  const selected =
    selectedValid && detail.isSuccess && !detail.isFetching ? (detail.data.workflow ?? undefined) : undefined;
  const runs = useQuery({
    queryKey: featureOwnedKey([...workflowsKey, "runs"], owner),
    enabled: tab === "runs" && owner.readable && !owner.denied,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const result = await apiClient.request(endpoints.domains.agents.workflows.runs, {
        query: { limit: 50 },
        signal,
        routeId: "agents.workflows",
      });
      assertFeatureRead(owner, signal);
      return result;
    },
  });
  const workflows = useMemo(() => list.data?.workflows ?? [], [list.data?.workflows]);

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
  const { runColumns } = useWorkflowColumns(workflows);

  const enabledCount = list.data?.summary.enabled ?? 0;
  const stepTotal = workflows.reduce((total, workflow) => total + workflow.step_count, 0);
  const summaryUnavailable = list.isPending || (list.isError && !list.data);

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
        <StatCard
          label="전체 워크플로"
          value={summaryUnavailable ? "—" : formatNumber(list.data?.summary.total ?? 0)}
        />
        <StatCard
          label="사용 중"
          tone="success"
          value={summaryUnavailable ? "—" : formatNumber(enabledCount)}
        />
        <StatCard label="현재 페이지 단계" value={summaryUnavailable ? "—" : formatNumber(stepTotal)} />
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
          { id: "list", label: "워크플로", badge: formatNumber(list.data?.summary.total ?? 0) },
          { id: "runs", label: "실행 이력" },
        ]}
        onChange={setTab}
        panelIdPrefix="workflows"
        value={tab}
      />

      {tab === "list" ? (
        <TabPanel id="list" panelIdPrefix="workflows">
          <WorkflowListPanel
            state={state}
            result={list}
            owner={owner}
            update={updateSearch}
            returnFocusRef={rowTriggerRef}
          />
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
        owner={owner}
        onOpenChange={(open) => {
          if (!open) setReceiptRunId("");
        }}
        returnFocusRef={rowTriggerRef}
        runId={receiptRunId}
      />

      <WorkflowDetailSheet
        owner={owner}
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
        open={params.has("workflow")}
        loading={selectedValid && (detail.isPending || detail.isFetching)}
        detailError={selectedValid ? detail.error : undefined}
        invalidAddress={params.has("workflow") && !selectedValid}
        onRetry={() => void detail.refetch()}
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
