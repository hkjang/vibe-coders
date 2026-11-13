import { Plus, RefreshCw } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { useAuth } from "@/app/auth/AuthProvider";
import { AppScopeBoundary, appsKey, useAppRead, useAppOperationAccess, useAppScope } from "./app-scope";
import { WorkAppListPanel } from "./WorkAppListPanel";
import { readWorkAppPage, validWorkAppDetailId } from "./work-app-page-model";
import { useWorkAppPageQuery, useWorkAppDetailQuery } from "./use-work-app-queries";
import { AppDetailSheet } from "@/features/agents/apps/AppDetailSheet";
import { AppDeleteDialog } from "@/features/agents/apps/AppDeleteDialog";
import { AppFormDialog } from "@/features/agents/apps/AppFormDialog";
import { AppReceiptDialog } from "@/features/agents/apps/AppReceiptDialog";
import { appWriteBody, type AppFormOutput } from "@/features/agents/apps/app-form";
import { OnboardingChecklist } from "@/features/agents/apps/OnboardingChecklist";
import { withPathParams } from "@/features/agents/endpoint-path";
import { displayColumn } from "@/features/agents/table-columns";
import { apiClient } from "@/shared/api/client";
import type { AppRun, AppTemplate, OnboardingCheck, WorkApp } from "@/shared/api/domains/agents.schemas";
import { onboardingCheckSchema } from "@/shared/api/domains/agents.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Tabs, TabPanel } from "@/shared/components/ui/Tabs";
import type { DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import { formatDateTime, formatDuration, formatNumber } from "@/shared/utils/format";
import { readRunSelection, validReceiptId, runState, appRunSummary } from "../receipts/run-receipt";
import { RunReceiptLink } from "../receipts/RunReceiptLink";
import "@/features/agents/agents.css";

const tabIds = ["apps", "templates", "runs"] as const;
type TabId = (typeof tabIds)[number];
const publishGateSchema = z.object({ checks: z.array(onboardingCheckSchema).min(1) });

/** The publish gate answers 422 with the readiness checklist; surface it instead of a bare error. */
function publishGateChecks(error: unknown): readonly OnboardingCheck[] | undefined {
  if (!isAppError(error) || error.status !== 422) return undefined;
  const parsed = publishGateSchema.safeParse(error.details);
  if (
    !parsed.success ||
    !parsed.data.checks.some((check) => check.severity === "required" && check.ok === false)
  )
    return undefined;
  return parsed.data.checks;
}

export function AppPage(): React.JSX.Element {
  return (
    <AppScopeBoundary>
      <AppPageContent />
    </AppScopeBoundary>
  );
}

function AppPageContent(): React.JSX.Element {
  const client = useQueryClient();
  const auth = useAuth();
  const operations = useAppOperationAccess();
  const owner = useAppScope();
  const canWrite = operations.allowed;
  const writeDisabledReason = operations.reason ?? "";
  const [tab, setTab] = useTabParam<TabId>([...tabIds]);
  const [params, updateSearch] = useSearchState();
  const state = readWorkAppPage(params, auth.credentialPrefixes);
  const receipt = readRunSelection(params, "app", auth.credentialPrefixes);
  const selectedId = params.get("app") ?? "";
  const selectedValid =
    !receipt.open &&
    params.getAll("app").length === 1 &&
    validWorkAppDetailId(selectedId, auth.credentialPrefixes);
  const selection = useRef(selectedId);
  useLayoutEffect(() => {
    selection.current = selectedId;
  }, [selectedId]);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<WorkApp | undefined>();
  const [publishTarget, setPublishTarget] = useState<WorkApp | undefined>();
  const [forceTarget, setForceTarget] = useState<WorkApp | undefined>();
  const [gateChecks, setGateChecks] = useState<readonly OnboardingCheck[]>([]);
  const [deprecateTarget, setDeprecateTarget] = useState<WorkApp | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<WorkApp | undefined>();
  const [templateTarget, setTemplateTarget] = useState<AppTemplate | undefined>();
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const rowTriggerRef = useRef<HTMLElement | null>(null);
  const deleteReturnRef = useRef<HTMLElement | null>(null);
  const dialogReturnRef = useRef<HTMLElement | null>(null);

  const list = useWorkAppPageQuery(state.query);
  const detail = useWorkAppDetailQuery(selectedValid ? selectedId : undefined);
  const selected =
    selectedValid && detail.isSuccess && !detail.isFetching ? (detail.data.app ?? undefined) : undefined;

  const templates = useAppRead({
    queryKey: [...appsKey, "templates"],
    enabled: tab === "templates",
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.agents.apps.templates, { signal, routeId: "agents.apps" }),
  });

  const runs = useAppRead({
    queryKey: [...appsKey, "runs"],
    enabled: tab === "runs",
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.agents.apps.runs, {
        query: { limit: 50 },
        signal,
        routeId: "agents.apps",
      }),
  });

  const closeSheet = useCallback((): void => {
    updateSearch({ app: undefined });
  }, [updateSearch]);

  const save = useMutationFeedback({
    gcTime: 0,
    ownsResult: operations.ownsResult,
    mutate: (variables: { values: AppFormOutput; id?: string }) =>
      variables.id === undefined
        ? apiClient
            .request(endpoints.domains.agents.apps.create, {
              body: appWriteBody(variables.values),
              retryUnauthorized: false,
              routeId: "agents.apps",
            })
            .then(operations.refreshReads)
        : apiClient
            .request(withPathParams(endpoints.domains.agents.apps.update, { id: variables.id }), {
              body: appWriteBody(variables.values),
              retryUnauthorized: false,
              routeId: "agents.apps",
            })
            .then(operations.refreshReads),
    successMessage: "AI 업무 앱을 저장했습니다.",
    errorMessage: "AI 업무 앱을 저장하지 못했습니다.",
  });

  const remove = useMutationFeedback({
    gcTime: 0,
    ownsResult: operations.ownsResult,
    mutate: (id: string) =>
      apiClient
        .request(withPathParams(endpoints.domains.agents.apps.remove, { id }), {
          retryUnauthorized: false,
          routeId: "agents.apps",
        })
        .then(operations.refreshReads),
    successMessage: "AI 업무 앱을 삭제했습니다.",
    errorMessage: "AI 업무 앱을 삭제하지 못했습니다.",
    onSuccess: (_, id) => {
      if (selection.current === id) closeSheet();
    },
  });

  const deprecate = useMutationFeedback({
    gcTime: 0,
    ownsResult: operations.ownsResult,
    mutate: (id: string) =>
      apiClient
        .request(withPathParams(endpoints.domains.agents.apps.deprecate, { id }), {
          retryUnauthorized: false,
          routeId: "agents.apps",
        })
        .then(operations.refreshReads),
    successMessage: "AI 업무 앱을 지원 중단했습니다.",
    errorMessage: "AI 업무 앱을 지원 중단하지 못했습니다.",
  });

  const publish = useMutationFeedback({
    gcTime: 0,
    ownsResult: operations.ownsResult,
    mutate: async (variables: { id: string; note: string; force?: boolean }) => {
      const result = await apiClient.request(
        withPathParams(endpoints.domains.agents.apps.publish, { id: variables.id }),
        {
          body: { note: variables.note },
          retryUnauthorized: false,
          ...(variables.force ? { query: { force: "1" as const } } : {}),
          routeId: "agents.apps",
        },
      );
      operations.assertCurrent();
      await client.invalidateQueries({ queryKey: operations.versionsKey(variables.id) });
      return operations.refreshReads(result);
    },
    successMessage: (result) =>
      result.version === undefined
        ? "AI 업무 앱을 발행했습니다."
        : `AI 업무 앱을 발행했습니다. (v${formatNumber(result.version)})`,
    errorMessage: "AI 업무 앱을 발행하지 못했습니다.",
  });

  const instantiate = useMutationFeedback({
    gcTime: 0,
    ownsResult: operations.ownsResult,
    mutate: (variables: { key: string }) =>
      apiClient
        .request(endpoints.domains.agents.apps.instantiateTemplate, {
          body: { key: variables.key },
          retryUnauthorized: false,
          routeId: "agents.apps",
        })
        .then(operations.refreshReads),
    successMessage: "템플릿에서 AI 업무 앱을 만들었습니다.",
    errorMessage: "템플릿에서 앱을 만들지 못했습니다.",
    onSuccess: () => setTab("apps"),
  });

  const captureReceiptTrigger = useCallback((element: HTMLElement) => {
    rowTriggerRef.current = element;
  }, []);
  const runColumns = useMemo<ReadonlyArray<DataTableColumn<AppRun>>>(
    () => [
      displayColumn<AppRun>("created_at", "실행 시각", (row) => formatDateTime(row.created_at)),
      displayColumn<AppRun>("app", "앱", (row) => row.app_title || row.app_id || "—"),
      displayColumn<AppRun>("status", "상태", (row) => (
        <Badge tone={runState(row.status).tone}>{runState(row.status).label}</Badge>
      )),
      displayColumn<AppRun>("summary", "요약", (row) => appRunSummary(row.output_summary)),
      displayColumn<AppRun>("latency", "소요", (row) => (
        <span className="cell-number">{formatDuration(row.latency_ms ?? 0)}</span>
      )),
      displayColumn<AppRun>("error", "오류 분류", (row) => row.error_class || "—"),
      displayColumn<AppRun>("receipt", "영수증", (row) => (
        <RunReceiptLink id={row.id} resource="app" onOpen={captureReceiptTrigger} />
      )),
    ],
    [captureReceiptTrigger],
  );

  const activeCount = list.data?.summary.active ?? 0;
  const unscopedCount = list.data?.summary.unscoped ?? 0;
  const summaryUnavailable = list.isPending || (list.isError && !list.data);
  const header = (
    <PageHeader
      title="AI 업무 앱"
      description="스킬·프롬프트·리포트를 묶은 업무 앱을 만들고 검증·발행하며 접근 권한을 관리합니다."
      legacyHref="/admin#/apps"
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
            <Plus aria-hidden="true" /> 새 업무 앱
          </Button>
        </>
      }
    />
  );

  return (
    <div className="page-stack">
      {header}

      <StatGrid label="AI 업무 앱 요약">
        <StatCard
          label="전체 앱"
          value={summaryUnavailable ? "—" : formatNumber(list.data?.summary.total ?? 0)}
        />
        <StatCard label="활성" tone="success" value={summaryUnavailable ? "—" : formatNumber(activeCount)} />
        <StatCard
          label="공개 범위 미지정"
          tone={unscopedCount > 0 ? "warning" : "default"}
          value={summaryUnavailable ? "—" : formatNumber(unscopedCount)}
          hint="팀·역할 제한이 없는 앱"
        />
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

      {forceTarget === undefined && gateChecks.length > 0 ? (
        <InlineNotice
          tone="warning"
          title="발행 전 온보딩 필수 항목이 충족되지 않았습니다."
          actions={
            <Button size="small" onClick={() => setGateChecks([])}>
              닫기
            </Button>
          }
        >
          <OnboardingChecklist checks={gateChecks} label="발행 차단 점검 결과" />
        </InlineNotice>
      ) : null}

      <Tabs
        ariaLabel="AI 업무 앱 화면"
        items={[
          { id: "apps", label: "업무 앱", badge: formatNumber(list.data?.summary.total ?? 0) },
          { id: "templates", label: "앱 템플릿" },
          { id: "runs", label: "실행 이력" },
        ]}
        onChange={setTab}
        panelIdPrefix="apps"
        value={tab}
      />

      {tab === "apps" ? (
        <TabPanel id="apps" panelIdPrefix="apps">
          <WorkAppListPanel
            state={state}
            result={list}
            owner={owner}
            update={updateSearch}
            returnFocusRef={rowTriggerRef}
          />
          {list.data?.summary.total === 0 ? (
            <Button onClick={() => setTab("templates")}>앱 템플릿 보기</Button>
          ) : null}
        </TabPanel>
      ) : tab === "templates" ? (
        <TabPanel id="templates" panelIdPrefix="apps">
          <p>{templates.data?.note ?? "내장 업무 앱 시작 템플릿입니다."}</p>
          {templates.isError ? (
            <InlineNotice
              tone="danger"
              title="템플릿을 불러오지 못했습니다."
              actions={
                <Button size="small" onClick={() => void templates.refetch()}>
                  다시 시도
                </Button>
              }
            >
              {safeAppErrorMessage(templates.error, "템플릿을 불러오지 못했습니다.")}
            </InlineNotice>
          ) : null}
          {templates.isPending ? (
            <LoadingState label="앱 템플릿을 불러오는 중입니다." />
          ) : (templates.data?.templates ?? []).length === 0 ? (
            <EmptyState title="사용할 수 있는 템플릿이 없습니다." />
          ) : (
            <ul className="agents-card-grid" aria-label="앱 템플릿 목록">
              {(templates.data?.templates ?? []).map((template) => (
                <li key={template.key} className="agents-card">
                  <h3>
                    {template.icon ?? ""} {template.title ?? template.key}
                  </h3>
                  <p>{template.description ?? ""}</p>
                  <p>
                    <Badge tone="info">{template.category ?? "기타"}</Badge> 구성 요소{" "}
                    {formatNumber(template.components?.length ?? 0)}개
                  </p>
                  <div className="agents-card-actions">
                    <Button
                      variant="primary"
                      size="small"
                      disabled={!canWrite}
                      title={canWrite ? undefined : writeDisabledReason}
                      onClick={() => setTemplateTarget(template)}
                    >
                      앱 생성
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </TabPanel>
      ) : (
        <TabPanel id="runs" panelIdPrefix="apps">
          <p>
            내 계정이 실행한 업무 앱의 영수증입니다. 입력은 해시로만 남고 원문 입력·출력은 저장되지 않습니다.
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
            caption="내 업무 앱 실행 이력"
            columns={runColumns}
            data={runs.data?.runs ?? []}
            emptyMessage="아직 실행한 업무 앱이 없습니다."
            getRowId={(row) => row.id}
            getRowActionLabel={(row) =>
              validReceiptId(row.id, auth.credentialPrefixes)
                ? `실행 ${row.id} 영수증 열기`
                : "영수증 주소 확인 필요"
            }
            loading={runs.isPending}
            onRowClick={(row) => {
              if (!validReceiptId(row.id, auth.credentialPrefixes)) return;
              rowTriggerRef.current = document.activeElement as HTMLElement | null;
              updateSearch({ run: row.id, app: undefined, tab: "runs" }, { replace: false });
            }}
          />
        </TabPanel>
      )}

      <AppReceiptDialog
        open={receipt.open}
        invalidAddress={receipt.invalid}
        onOpenChange={(open) => {
          if (!open) updateSearch({ run: undefined });
        }}
        returnFocusRef={rowTriggerRef}
        runId={receipt.id}
      />

      <AppDetailSheet
        app={selected}
        loading={selectedValid && (detail.isPending || detail.isFetching)}
        detailError={selectedValid ? detail.error : undefined}
        invalidAddress={params.has("app") && !selectedValid}
        onRetry={() => void detail.refetch()}
        canWrite={canWrite}
        onDelete={() => {
          deleteReturnRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setDeleteTarget(selected);
        }}
        onDeprecate={() => setDeprecateTarget(selected)}
        onEdit={() => {
          setEditing(selected);
          setFormOpen(true);
        }}
        onOpenChange={(open) => {
          if (!open) closeSheet();
        }}
        onPublish={() => setPublishTarget(selected)}
        open={!receipt.open && params.has("app")}
        returnFocusRef={rowTriggerRef}
        writeDisabledReason={writeDisabledReason}
      />

      <AppFormDialog
        key={JSON.stringify([formOpen, editing?.id])}
        app={editing}
        onOpenChange={setFormOpen}
        onSubmit={async (values) => {
          await save.mutateAsync({ values, id: editing?.id });
        }}
        open={formOpen}
        owner={auth.user?.email ?? ""}
        returnFocusRef={dialogReturnRef}
      />

      <ConfirmDialog
        confirmDisabled={!canWrite}
        title="업무 앱 발행"
        description={`'${publishTarget?.title ?? ""}' 앱의 현재 정의를 새 버전으로 발행합니다. 온보딩 필수 항목이 비어 있으면 차단됩니다.`}
        confirmLabel="발행"
        requireReason
        open={publishTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setPublishTarget(undefined);
        }}
        onConfirm={async (reason) => {
          if (!publishTarget) return;
          try {
            await publish.mutateAsync({ id: publishTarget.id, note: reason });
          } catch (error) {
            operations.assertCurrent();
            const checks = publishGateChecks(error);
            if (checks) {
              setGateChecks(checks);
              setForceTarget(publishTarget);
            }
            throw error;
          }
        }}
        returnFocusRef={rowTriggerRef}
      />

      <ConfirmDialog
        confirmDisabled={!canWrite}
        title="온보딩 미충족 상태로 강제 발행"
        description={`'${forceTarget?.title ?? ""}' 앱은 온보딩 필수 항목을 충족하지 않았습니다. 그래도 발행하면 거버넌스 공백이 남습니다.`}
        confirmLabel="강제 발행"
        tone="danger"
        requireReason
        open={forceTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setForceTarget(undefined);
        }}
        onConfirm={async (reason) => {
          if (forceTarget) await publish.mutateAsync({ id: forceTarget.id, note: reason, force: true });
        }}
        returnFocusRef={rowTriggerRef}
      >
        <OnboardingChecklist checks={gateChecks} label="발행 차단 점검 결과" />
      </ConfirmDialog>

      <ConfirmDialog
        confirmDisabled={!canWrite}
        title="업무 앱 지원 중단"
        description={`'${deprecateTarget?.title ?? ""}' 앱을 보관 상태로 바꿔 사용자에게 더 이상 노출하지 않습니다.`}
        confirmLabel="지원 중단"
        open={deprecateTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeprecateTarget(undefined);
        }}
        onConfirm={async () => {
          if (deprecateTarget) await deprecate.mutateAsync(deprecateTarget.id);
        }}
        returnFocusRef={rowTriggerRef}
      />

      {deleteTarget ? (
        <AppDeleteDialog
          key={deleteTarget.id}
          id={deleteTarget.id}
          onClose={() => setDeleteTarget(undefined)}
          onDelete={(id) => remove.mutateAsync(id)}
          returnFocusRef={deleteReturnRef}
        />
      ) : null}

      <ConfirmDialog
        confirmDisabled={!canWrite}
        title="템플릿에서 앱 만들기"
        description={`'${templateTarget?.title ?? ""}' 템플릿으로 편집 가능한 업무 앱을 만듭니다. 생성 후 구성 요소의 ref를 환경에 맞게 수정하세요.`}
        confirmLabel="앱 생성"
        open={templateTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setTemplateTarget(undefined);
        }}
        onConfirm={async () => {
          if (templateTarget) await instantiate.mutateAsync({ key: templateTarget.key });
        }}
        returnFocusRef={rowTriggerRef}
      />
    </div>
  );
}
import { useQueryClient } from "@tanstack/react-query";
