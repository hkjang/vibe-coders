import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { useAuth } from "@/app/auth/AuthProvider";
import { AppDetailSheet } from "@/features/agents/apps/AppDetailSheet";
import { AppFormDialog } from "@/features/agents/apps/AppFormDialog";
import { AppReceiptDialog } from "@/features/agents/apps/AppReceiptDialog";
import { appWriteBody, matchesAppQuery, type AppFormOutput } from "@/features/agents/apps/app-form";
import { OnboardingChecklist } from "@/features/agents/apps/OnboardingChecklist";
import { withPathParams } from "@/features/agents/endpoint-path";
import { displayColumn } from "@/features/agents/table-columns";
import { apiClient } from "@/shared/api/client";
import type {
  AppRun,
  AppRunPlan,
  AppTemplate,
  AppValidation,
  OnboardingCheck,
  WorkApp,
} from "@/shared/api/domains/agents.schemas";
import { onboardingCheckSchema } from "@/shared/api/domains/agents.schemas";
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
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { formatDateTime, formatDuration, formatNumber } from "@/shared/utils/format";
import "@/features/agents/agents.css";

const tabIds = ["apps", "templates", "runs"] as const;
type TabId = (typeof tabIds)[number];
const appsKey = ["agents", "apps"] as const;
const writeDisabledReason = "AI 업무 앱을 변경하려면 admin:write 권한이 필요합니다.";
const statusFilters = [
  { value: "all", label: "전체 상태" },
  { value: "active", label: "활성" },
  { value: "archived", label: "보관" },
];

const publishGateSchema = z.object({ checks: z.array(onboardingCheckSchema).nullish() });

/** The publish gate answers 422 with the readiness checklist; surface it instead of a bare error. */
function publishGateChecks(error: unknown): readonly OnboardingCheck[] | undefined {
  if (!isAppError(error) || error.status !== 422) return undefined;
  const parsed = publishGateSchema.safeParse(error.details);
  if (!parsed.success) return [];
  return parsed.data.checks ?? [];
}

export function AppPage(): React.JSX.Element {
  const auth = useAuth();
  const canWrite = auth.user?.scopes.includes("admin:write") ?? false;
  const [tab, setTab] = useTabParam<TabId>([...tabIds]);
  const [params, updateSearch] = useSearchState();
  const refreshInterval = useRefreshInterval();
  const rawQuery = params.get("q") ?? "";
  const query = containsPotentialSecret(rawQuery) ? "" : rawQuery;
  const status = params.get("status") ?? "all";
  const selectedId = params.get("app") ?? "";
  const [searchError, setSearchError] = useState<string | undefined>(
    containsPotentialSecret(rawQuery) ? secretSearchMessage : undefined,
  );
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<WorkApp | undefined>();
  const [publishTarget, setPublishTarget] = useState<WorkApp | undefined>();
  const [forceTarget, setForceTarget] = useState<WorkApp | undefined>();
  const [gateChecks, setGateChecks] = useState<readonly OnboardingCheck[]>([]);
  const [deprecateTarget, setDeprecateTarget] = useState<WorkApp | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<WorkApp | undefined>();
  const [templateTarget, setTemplateTarget] = useState<AppTemplate | undefined>();
  const [validation, setValidation] = useState<AppValidation | undefined>();
  const [runPlan, setRunPlan] = useState<AppRunPlan | undefined>();
  const [receiptRunId, setReceiptRunId] = useState("");
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const rowTriggerRef = useRef<HTMLElement | null>(null);
  const dialogReturnRef = useRef<HTMLElement | null>(null);

  const list = useQuery({
    queryKey: appsKey,
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.agents.apps.list, { signal, routeId: "agents.apps" }),
    refetchInterval: refreshInterval,
    refetchIntervalInBackground: false,
  });

  const templates = useQuery({
    queryKey: [...appsKey, "templates"],
    enabled: tab === "templates",
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.agents.apps.templates, { signal, routeId: "agents.apps" }),
  });

  const runs = useQuery({
    queryKey: [...appsKey, "runs"],
    enabled: tab === "runs",
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.agents.apps.runs, {
        query: { limit: 50 },
        signal,
        routeId: "agents.apps",
      }),
  });

  const apps = useMemo(() => list.data?.apps ?? [], [list.data?.apps]);
  const rows = useMemo(
    () =>
      apps.filter(
        (app) => matchesAppQuery(app, query) && (status === "all" || (app.status ?? "") === status),
      ),
    [apps, query, status],
  );
  const selected = apps.find((app) => app.id === selectedId);

  const closeSheet = useCallback((): void => {
    setValidation(undefined);
    setRunPlan(undefined);
    updateSearch({ app: undefined });
  }, [updateSearch]);

  const save = useMutationFeedback({
    mutate: (variables: { values: AppFormOutput; id?: string }) =>
      variables.id === undefined
        ? apiClient.request(endpoints.domains.agents.apps.create, {
            body: appWriteBody(variables.values),
            routeId: "agents.apps",
          })
        : apiClient.request(withPathParams(endpoints.domains.agents.apps.update, { id: variables.id }), {
            body: appWriteBody(variables.values),
            routeId: "agents.apps",
          }),
    invalidates: [appsKey],
    successMessage: "AI 업무 앱을 저장했습니다.",
    errorMessage: "AI 업무 앱을 저장하지 못했습니다.",
  });

  const remove = useMutationFeedback({
    mutate: (id: string) =>
      apiClient.request(withPathParams(endpoints.domains.agents.apps.remove, { id }), {
        routeId: "agents.apps",
      }),
    invalidates: [appsKey],
    successMessage: "AI 업무 앱을 삭제했습니다.",
    errorMessage: "AI 업무 앱을 삭제하지 못했습니다.",
    onSuccess: () => closeSheet(),
  });

  const deprecate = useMutationFeedback({
    mutate: (id: string) =>
      apiClient.request(withPathParams(endpoints.domains.agents.apps.deprecate, { id }), {
        routeId: "agents.apps",
      }),
    invalidates: [appsKey],
    successMessage: "AI 업무 앱을 지원 중단했습니다.",
    errorMessage: "AI 업무 앱을 지원 중단하지 못했습니다.",
  });

  const publish = useMutationFeedback({
    mutate: (variables: { id: string; note: string; force?: boolean }) =>
      apiClient.request(withPathParams(endpoints.domains.agents.apps.publish, { id: variables.id }), {
        body: { note: variables.note },
        ...(variables.force ? { query: { force: "1" as const } } : {}),
        routeId: "agents.apps",
      }),
    invalidates: [appsKey],
    successMessage: (result) => `AI 업무 앱을 발행했습니다. (v${formatNumber(result.version ?? 0)})`,
    errorMessage: "AI 업무 앱을 발행하지 못했습니다.",
  });

  const instantiate = useMutationFeedback({
    mutate: (variables: { key: string }) =>
      apiClient.request(endpoints.domains.agents.apps.instantiateTemplate, {
        body: { key: variables.key },
        routeId: "agents.apps",
      }),
    invalidates: [appsKey],
    successMessage: "템플릿에서 AI 업무 앱을 만들었습니다.",
    errorMessage: "템플릿에서 앱을 만들지 못했습니다.",
    onSuccess: () => setTab("apps"),
  });

  const validate = useMutation({
    mutationFn: (id: string) =>
      apiClient.request(withPathParams(endpoints.domains.agents.apps.validate, { id }), {
        routeId: "agents.apps",
      }),
    onSuccess: (result) => setValidation(result),
  });

  const run = useMutation({
    mutationFn: (id: string) =>
      apiClient.request(withPathParams(endpoints.domains.agents.apps.run, { id }), {
        routeId: "agents.apps",
      }),
    onSuccess: (result) => setRunPlan(result),
  });

  const columns = useMemo<ReadonlyArray<DataTableColumn<WorkApp>>>(
    () => [
      displayColumn<WorkApp>("title", "앱", (row) => (
        <span className="truncate">{`${row.icon ?? ""} ${row.title ?? row.id}`.trim()}</span>
      )),
      displayColumn<WorkApp>("status", "상태", (row) => (
        <Badge tone={row.status === "active" ? "success" : "muted"}>
          {row.status === "active" ? "활성" : (row.status ?? "—")}
        </Badge>
      )),
      displayColumn<WorkApp>("components", "구성 요소", (row) => (
        <span className="cell-number">{formatNumber(row.components?.length ?? 0)}</span>
      )),
      displayColumn<WorkApp>("scope", "허용 팀/역할", (row) =>
        [row.allowed_teams || "전체 팀", row.allowed_roles || "전체 역할"].join(" · "),
      ),
      displayColumn<WorkApp>("owner", "책임자", (row) => row.owner || "—"),
      displayColumn<WorkApp>("updated_at", "수정일", (row) => formatDateTime(row.updated_at)),
    ],
    [],
  );

  const runColumns = useMemo<ReadonlyArray<DataTableColumn<AppRun>>>(
    () => [
      displayColumn<AppRun>("created_at", "실행 시각", (row) => formatDateTime(row.created_at)),
      displayColumn<AppRun>(
        "app",
        "앱",
        (row) => apps.find((app) => app.id === row.app_id)?.title ?? row.app_id ?? "—",
      ),
      displayColumn<AppRun>("status", "상태", (row) => (
        <Badge tone={row.status === "error" ? "danger" : row.status === "ok" ? "success" : "info"}>
          {row.status || "—"}
        </Badge>
      )),
      displayColumn<AppRun>("summary", "요약", (row) => row.output_summary || "—"),
      displayColumn<AppRun>("latency", "소요", (row) => (
        <span className="cell-number">{formatDuration(row.latency_ms ?? 0)}</span>
      )),
      displayColumn<AppRun>("error", "오류 분류", (row) => row.error_class || "—"),
    ],
    [apps],
  );

  const activeCount = apps.filter((app) => app.status === "active").length;
  const unscopedCount = apps.filter(
    (app) => (app.allowed_teams ?? "") === "" && (app.allowed_roles ?? "") === "",
  ).length;
  const summaryUnavailable = list.isPending || (list.isError && !list.data);
  const header = (
    <PageHeader
      title="AI 업무 앱"
      description="Skill·프롬프트·리포트를 묶은 업무 앱을 만들고 검증·발행하며 접근 권한을 관리합니다."
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

  if (list.isPending && !list.data) {
    return (
      <div className="page-stack">
        {header}
        <LoadingState label="AI 업무 앱 목록을 불러오는 중입니다." />
      </div>
    );
  }

  if (list.isError && !list.data) {
    return (
      <div className="page-stack">
        {header}
        <ErrorState
          message={safeAppErrorMessage(list.error, "AI 업무 앱 목록을 불러오지 못했습니다.")}
          requestId={isAppError(list.error) ? list.error.requestId : undefined}
          onRetry={() => void list.refetch()}
          legacyHref="/admin#/apps"
        />
      </div>
    );
  }

  return (
    <div className="page-stack">
      {header}

      <StatGrid label="AI 업무 앱 요약">
        <StatCard label="전체 앱" value={summaryUnavailable ? "—" : formatNumber(apps.length)} />
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
          { id: "apps", label: "업무 앱", badge: formatNumber(apps.length) },
          { id: "templates", label: "앱 템플릿" },
          { id: "runs", label: "실행 이력" },
        ]}
        onChange={setTab}
        panelIdPrefix="apps"
        value={tab}
      />

      {tab === "apps" ? (
        <TabPanel id="apps" panelIdPrefix="apps">
          <Toolbar label="업무 앱 필터">
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
              <label htmlFor="app-search">업무 앱 검색</label>
              <Input
                id="app-search"
                key={query}
                name="q"
                defaultValue={query}
                placeholder="제목, 설명, 책임자, 팀"
                aria-invalid={searchError ? "true" : undefined}
                aria-describedby={searchError ? "app-search-error" : undefined}
              />
              {searchError ? (
                <span id="app-search-error" className="field-error" role="alert">
                  {searchError}
                </span>
              ) : null}
            </form>
            <label className="agents-toolbar-field" htmlFor="app-status">
              <span>상태</span>
              <Select
                id="app-status"
                value={status}
                options={statusFilters}
                onChange={(event) =>
                  updateSearch({ status: event.target.value === "all" ? undefined : event.target.value })
                }
              />
            </label>
          </Toolbar>

          {apps.length === 0 ? (
            <EmptyState
              title="아직 업무 앱이 없습니다."
              description="앱 템플릿에서 시작하거나 구성 요소를 직접 묶어 새 업무 앱을 만드세요."
              actions={
                <Button variant="secondary" onClick={() => setTab("templates")}>
                  앱 템플릿 보기
                </Button>
              }
            />
          ) : (
            <DataTable
              caption="AI 업무 앱 목록"
              columns={columns}
              data={rows}
              emptyMessage="조건에 맞는 업무 앱이 없습니다."
              getRowId={(row) => row.id}
              getRowActionLabel={(row) => `${row.title ?? row.id} 상세 열기`}
              onRowClick={(row) => {
                rowTriggerRef.current = document.activeElement as HTMLElement | null;
                setValidation(undefined);
                setRunPlan(undefined);
                updateSearch({ app: row.id });
              }}
            />
          )}
          <p className="agents-updated">마지막 갱신 {formatDateTime(list.dataUpdatedAt)}</p>
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
            getRowActionLabel={(row) => `실행 ${row.id} 영수증 열기`}
            loading={runs.isPending}
            onRowClick={(row) => {
              rowTriggerRef.current = document.activeElement as HTMLElement | null;
              setReceiptRunId(row.id);
            }}
          />
        </TabPanel>
      )}

      <AppReceiptDialog
        onOpenChange={(open) => {
          if (!open) setReceiptRunId("");
        }}
        returnFocusRef={rowTriggerRef}
        runId={receiptRunId}
      />

      <AppDetailSheet
        app={selected}
        canWrite={canWrite}
        onDelete={() => setDeleteTarget(selected)}
        onDeprecate={() => setDeprecateTarget(selected)}
        onEdit={() => {
          setEditing(selected);
          setFormOpen(true);
        }}
        onOpenChange={(open) => {
          if (!open) closeSheet();
        }}
        onPublish={() => setPublishTarget(selected)}
        onRun={() => {
          if (selected) run.mutate(selected.id);
        }}
        onValidate={() => {
          if (selected) validate.mutate(selected.id);
        }}
        open={selectedId !== ""}
        returnFocusRef={rowTriggerRef}
        runError={run.error}
        runPending={run.isPending}
        runPlan={runPlan}
        validation={validation}
        validationError={validate.error}
        validationPending={validate.isPending}
        writeDisabledReason={writeDisabledReason}
      />

      <AppFormDialog
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

      <ConfirmDialog
        title="업무 앱 삭제"
        description={`'${deleteTarget?.title ?? ""}' 앱을 삭제합니다. 이 작업은 되돌릴 수 없습니다.`}
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

      <ConfirmDialog
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
