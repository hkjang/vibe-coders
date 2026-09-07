import { useQuery } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import { withPathParams } from "@/features/agents/endpoint-path";
import { SkillAdoptDialog } from "@/features/agents/skills/SkillAdoptDialog";
import { SkillDetailSheet } from "@/features/agents/skills/SkillDetailSheet";
import { SkillFormDialog } from "@/features/agents/skills/SkillFormDialog";
import { SkillGraphView } from "@/features/agents/skills/SkillGraphView";
import { SkillReadinessPanel } from "@/features/agents/skills/SkillReadinessPanel";
import { SkillToolbox } from "@/features/agents/skills/SkillToolbox";
import {
  allowedSkillTransitions,
  matchesSkillQuery,
  riskTone,
  skillRiskLabels,
  skillStatusFilters,
  skillStatusLabels,
  skillWriteBody,
  statusTone,
  type SkillFormOutput,
} from "@/features/agents/skills/skill-form";
import { displayColumn } from "@/features/agents/table-columns";
import { apiClient } from "@/shared/api/client";
import type { Skill, SkillAdoptBody, SkillCandidate } from "@/shared/api/domains/agents.schemas";
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
import { SectionCard } from "@/shared/components/ui/SectionCard";
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
import { formatDateTime, formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";
import "@/features/agents/agents.css";

const tabIds = ["catalog", "studio", "graph"] as const;
type TabId = (typeof tabIds)[number];
const skillsKey = ["agents", "skills"] as const;
const writeDisabledReason = "Skill을 변경하려면 admin:write 권한이 필요합니다.";

export function SkillPage(): React.JSX.Element {
  const auth = useAuth();
  const canWrite = auth.user?.scopes.includes("admin:write") ?? false;
  const [tab, setTab] = useTabParam<TabId>([...tabIds]);
  const [params, updateSearch] = useSearchState();
  const refreshInterval = useRefreshInterval();
  const rawQuery = params.get("q") ?? "";
  const query = containsPotentialSecret(rawQuery) ? "" : rawQuery;
  const status = params.get("status") ?? "all";
  const selectedName = params.get("skill") ?? "";
  const [searchError, setSearchError] = useState<string | undefined>(
    containsPotentialSecret(rawQuery) ? secretSearchMessage : undefined,
  );
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Skill | undefined>();
  const [promoteTarget, setPromoteTarget] = useState<Skill | undefined>();
  const [promoteStatus, setPromoteStatus] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Skill | undefined>();
  const [adoptCandidate, setAdoptCandidate] = useState<SkillCandidate | undefined>();
  const [adoptOpen, setAdoptOpen] = useState(false);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const rowTriggerRef = useRef<HTMLElement | null>(null);
  const dialogReturnRef = useRef<HTMLElement | null>(null);

  const listQuery = status === "all" ? {} : { status };
  const list = useQuery({
    queryKey: [...skillsKey, status],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.agents.skills.list, {
        query: listQuery,
        signal,
        routeId: "agents.skills",
      }),
    refetchInterval: refreshInterval,
    refetchIntervalInBackground: false,
  });

  const stats = useQuery({
    queryKey: [...skillsKey, "stats"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.agents.skills.stats, {
        query: { window: "30d" },
        signal,
        routeId: "agents.skills",
      }),
  });

  const candidates = useQuery({
    queryKey: [...skillsKey, "candidates"],
    enabled: tab === "studio",
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.agents.skills.studioCandidates, {
        query: { window: "30d", limit: 40 },
        signal,
        routeId: "agents.skills",
      }),
  });

  const graph = useQuery({
    queryKey: [...skillsKey, "graph"],
    enabled: tab === "graph",
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.agents.skills.dependencyGraph, {
        signal,
        routeId: "agents.skills",
      }),
  });

  const skills = useMemo(() => list.data?.skills ?? [], [list.data?.skills]);
  const rows = useMemo(() => skills.filter((skill) => matchesSkillQuery(skill, query)), [query, skills]);
  const selected = skills.find((skill) => skill.name === selectedName);

  const closeSheet = useCallback((): void => updateSearch({ skill: undefined }), [updateSearch]);

  const save = useMutationFeedback({
    mutate: (values: SkillFormOutput) =>
      apiClient.request(endpoints.domains.agents.skills.upsert, {
        body: skillWriteBody(values),
        routeId: "agents.skills",
      }),
    invalidates: [skillsKey],
    successMessage: "Skill을 저장했습니다.",
    errorMessage: "Skill을 저장하지 못했습니다.",
  });

  const promote = useMutationFeedback({
    mutate: (variables: { name: string; to_status: string; note: string }) =>
      apiClient.request(endpoints.domains.agents.skills.promote, {
        body: variables,
        routeId: "agents.skills",
      }),
    invalidates: [skillsKey],
    successMessage: (_result, variables) =>
      `Skill을 ${skillStatusLabels[variables.to_status] ?? variables.to_status} 상태로 승격했습니다.`,
    errorMessage: "Skill을 승격하지 못했습니다.",
  });

  const remove = useMutationFeedback({
    mutate: (name: string) =>
      apiClient.request(withPathParams(endpoints.domains.agents.skills.remove, { name }), {
        routeId: "agents.skills",
      }),
    invalidates: [skillsKey],
    successMessage: "Skill을 삭제했습니다.",
    errorMessage: "Skill을 삭제하지 못했습니다.",
    onSuccess: () => closeSheet(),
  });

  const adopt = useMutationFeedback({
    mutate: (body: SkillAdoptBody) =>
      apiClient.request(endpoints.domains.agents.skills.studioAdopt, {
        body,
        routeId: "agents.skills",
      }),
    invalidates: [skillsKey],
    successMessage: "후보를 초안 Skill로 채택했습니다.",
    errorMessage: "후보를 채택하지 못했습니다.",
    onSuccess: (_result, body) => updateSearch({ skill: body.name }),
  });

  const columns = useMemo<ReadonlyArray<DataTableColumn<Skill>>>(
    () => [
      displayColumn<Skill>("name", "이름", (row) => <span className="mono truncate">{row.name}</span>),
      displayColumn<Skill>("version", "버전", (row) => row.version || "—"),
      displayColumn<Skill>("status", "상태", (row) => (
        <Badge tone={statusTone(row.status)}>
          {skillStatusLabels[row.status ?? ""] ?? row.status ?? "—"}
        </Badge>
      )),
      displayColumn<Skill>("risk", "위험", (row) => (
        <Badge tone={riskTone(row.risk_level)}>
          {skillRiskLabels[row.risk_level ?? ""] ?? row.risk_level ?? "—"}
        </Badge>
      )),
      displayColumn<Skill>("models", "허용 모델", (row) => (
        <span className="truncate">{row.allowed_models || "제한 없음"}</span>
      )),
      displayColumn<Skill>("teams", "허용 팀", (row) => row.allowed_teams || "전체"),
      displayColumn<Skill>("limit", "일일 한도", (row) => (
        <span className="cell-number">{row.daily_limit ? formatNumber(row.daily_limit) : "무제한"}</span>
      )),
      displayColumn<Skill>("updated_at", "수정일", (row) => formatDateTime(row.updated_at)),
    ],
    [],
  );

  const candidateColumns = useMemo<ReadonlyArray<DataTableColumn<SkillCandidate>>>(
    () => [
      displayColumn<SkillCandidate>("title", "후보", (row) => (
        <span className="truncate">{row.title ?? row.suggested_name ?? row.id}</span>
      )),
      displayColumn<SkillCandidate>("source", "출처", (row) => (
        <Badge tone="info">{row.source ?? "—"}</Badge>
      )),
      displayColumn<SkillCandidate>("rationale", "근거", (row) => (
        <span className="truncate">{row.rationale ?? "—"}</span>
      )),
      displayColumn<SkillCandidate>("already", "채택 여부", (row) =>
        row.already_skill ? <Badge tone="success">채택됨</Badge> : <Badge tone="muted">미채택</Badge>,
      ),
    ],
    [],
  );

  const statRows = stats.data?.stats ?? [];
  const totalRuns = statRows.reduce((total, entry) => total + Number(entry.runs ?? 0), 0);
  const totalBlocked = statRows.reduce((total, entry) => total + Number(entry.blocked ?? 0), 0);
  const totalCost = statRows.reduce((total, entry) => total + Number(entry.total_cost_krw ?? 0), 0);
  const productionCount = skills.filter((skill) => skill.status === "production").length;
  const summaryUnavailable = list.isPending || (list.isError && !list.data);

  const header = (
    <PageHeader
      title="Skill"
      description="Skill 카탈로그와 스튜디오, 의존성 그래프를 한 화면에서 관리합니다."
      legacyHref="/admin#/skills"
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
            <Plus aria-hidden="true" /> 새 Skill
          </Button>
        </>
      }
    />
  );

  if (list.isPending && !list.data) {
    return (
      <div className="page-stack">
        {header}
        <LoadingState label="Skill 목록을 불러오는 중입니다." />
      </div>
    );
  }

  if (list.isError && !list.data) {
    return (
      <div className="page-stack">
        {header}
        <ErrorState
          message={safeAppErrorMessage(list.error, "Skill 목록을 불러오지 못했습니다.")}
          requestId={isAppError(list.error) ? list.error.requestId : undefined}
          onRetry={() => void list.refetch()}
          legacyHref="/admin#/skills"
        />
      </div>
    );
  }

  return (
    <div className="page-stack">
      {header}

      <StatGrid label="Skill 요약">
        <StatCard label="전체 Skill" value={summaryUnavailable ? "—" : formatNumber(skills.length)} />
        <StatCard
          label="프로덕션"
          tone="success"
          value={summaryUnavailable ? "—" : formatNumber(productionCount)}
        />
        <StatCard
          label="30일 실행"
          value={stats.data ? formatNumber(totalRuns) : "—"}
          hint={stats.data ? `차단 ${formatPercent(totalRuns ? totalBlocked / totalRuns : 0)}` : undefined}
        />
        <StatCard label="30일 비용" value={stats.data ? formatKRW(totalCost) : "—"} />
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
      {stats.isError ? (
        <InlineNotice
          tone="warning"
          title="실행 통계를 불러오지 못했습니다."
          actions={
            <Button size="small" onClick={() => void stats.refetch()}>
              다시 시도
            </Button>
          }
        >
          카탈로그는 계속 사용할 수 있습니다.
        </InlineNotice>
      ) : null}

      <Tabs
        ariaLabel="Skill 화면"
        items={[
          { id: "catalog", label: "카탈로그", badge: formatNumber(skills.length) },
          { id: "studio", label: "스튜디오" },
          { id: "graph", label: "의존성 그래프" },
        ]}
        onChange={setTab}
        panelIdPrefix="skills"
        value={tab}
      />

      {tab === "catalog" ? (
        <TabPanel id="catalog" panelIdPrefix="skills">
          <Toolbar label="Skill 필터">
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
              <label htmlFor="skill-search">Skill 검색</label>
              <Input
                id="skill-search"
                key={query}
                name="q"
                defaultValue={query}
                placeholder="이름, 설명, 책임자, 팀"
                aria-invalid={searchError ? "true" : undefined}
                aria-describedby={searchError ? "skill-search-error" : undefined}
              />
              {searchError ? (
                <span id="skill-search-error" className="field-error" role="alert">
                  {searchError}
                </span>
              ) : null}
            </form>
            <label className="agents-toolbar-field" htmlFor="skill-status">
              <span>상태</span>
              <Select
                id="skill-status"
                value={status}
                options={skillStatusFilters}
                onChange={(event) =>
                  updateSearch({ status: event.target.value === "all" ? undefined : event.target.value })
                }
              />
            </label>
          </Toolbar>

          <SkillToolbox
            canWrite={canWrite}
            skillsKey={skillsKey}
            statusFilter={status}
            writeDisabledReason={writeDisabledReason}
          />

          {skills.length === 0 ? (
            <EmptyState
              title="등록된 Skill이 없습니다."
              description="추천 Skill을 시드하거나 스튜디오에서 후보를 채택하면 카탈로그가 채워집니다."
              actions={
                <Button variant="secondary" onClick={() => setTab("studio")}>
                  스튜디오 열기
                </Button>
              }
            />
          ) : (
            <DataTable
              caption="Skill 카탈로그"
              columns={columns}
              data={rows}
              emptyMessage="조건에 맞는 Skill이 없습니다."
              getRowId={(row) => row.name}
              getRowActionLabel={(row) => `${row.name} 상세 열기`}
              onRowClick={(row) => {
                rowTriggerRef.current = document.activeElement as HTMLElement | null;
                updateSearch({ skill: row.name });
              }}
            />
          )}
          <p className="agents-updated">마지막 갱신 {formatDateTime(list.dataUpdatedAt)}</p>
        </TabPanel>
      ) : tab === "studio" ? (
        <TabPanel id="studio" panelIdPrefix="skills">
          <SectionCard
            title="Skill 후보"
            headingLevel={3}
            description="반복 프롬프트·프롬프트 상품·반복 Text2SQL 질문·조직 추천에서 도출한 후보입니다."
          >
            {candidates.isError ? (
              <InlineNotice
                tone="danger"
                title="후보를 불러오지 못했습니다."
                actions={
                  <Button size="small" onClick={() => void candidates.refetch()}>
                    다시 시도
                  </Button>
                }
              >
                {safeAppErrorMessage(candidates.error, "후보를 불러오지 못했습니다.")}
              </InlineNotice>
            ) : null}
            <DataTable
              caption="Skill 스튜디오 후보 목록"
              columns={candidateColumns}
              data={candidates.data?.candidates ?? []}
              emptyMessage="도출된 후보가 없습니다."
              getRowId={(row) => row.id}
              getRowActionLabel={(row) => `${row.title ?? row.id} 채택하기`}
              loading={candidates.isPending}
              onRowClick={(row) => {
                dialogReturnRef.current = document.activeElement as HTMLElement | null;
                setAdoptCandidate(row);
                setAdoptOpen(true);
              }}
            />
          </SectionCard>

          <Toolbar label="승격 준비도 대상">
            <label className="agents-toolbar-field" htmlFor="studio-skill">
              <span>Skill 선택</span>
              <Select
                id="studio-skill"
                value={selectedName}
                onChange={(event) => updateSearch({ skill: event.target.value || undefined })}
              >
                <option value="">선택하세요</option>
                {skills.map((skill) => (
                  <option key={skill.name} value={skill.name}>
                    {skill.name} ({skillStatusLabels[skill.status ?? ""] ?? skill.status ?? ""})
                  </option>
                ))}
              </Select>
            </label>
          </Toolbar>

          <SkillReadinessPanel
            canWrite={canWrite}
            onPromote={(toStatus) => {
              setPromoteTarget(selected);
              setPromoteStatus(toStatus);
            }}
            skillName={selected ? selectedName : ""}
            writeDisabledReason={writeDisabledReason}
          />
        </TabPanel>
      ) : (
        <TabPanel id="graph" panelIdPrefix="skills">
          <p>{graph.data?.note ?? "프로덕션 Skill의 모델·도구·팀 의존성과 관할 정책을 보여줍니다."}</p>
          {graph.isError ? (
            <InlineNotice
              tone="danger"
              title="의존성 그래프를 불러오지 못했습니다."
              actions={
                <Button size="small" onClick={() => void graph.refetch()}>
                  다시 시도
                </Button>
              }
            >
              {safeAppErrorMessage(graph.error, "의존성 그래프를 불러오지 못했습니다.")}
            </InlineNotice>
          ) : null}
          {graph.isPending ? (
            <LoadingState label="의존성 그래프를 불러오는 중입니다." />
          ) : (
            <SkillGraphView
              edges={graph.data?.edges ?? []}
              nodes={graph.data?.nodes ?? []}
              skills={graph.data?.skills ?? []}
            />
          )}
        </TabPanel>
      )}

      <SkillDetailSheet
        canWrite={canWrite}
        onDelete={() => setDeleteTarget(selected)}
        onEdit={() => {
          setEditing(selected);
          setFormOpen(true);
        }}
        onOpenChange={(open) => {
          if (!open) closeSheet();
        }}
        onPromote={() => {
          setPromoteTarget(selected);
          setPromoteStatus(allowedSkillTransitions(selected?.status)[0] ?? "staging");
        }}
        open={tab === "catalog" && selectedName !== ""}
        returnFocusRef={rowTriggerRef}
        skill={selected}
        writeDisabledReason={writeDisabledReason}
      />

      <SkillFormDialog
        onOpenChange={setFormOpen}
        onSubmit={async (values) => {
          await save.mutateAsync(values);
        }}
        open={formOpen}
        returnFocusRef={dialogReturnRef}
        skill={editing}
      />

      <SkillAdoptDialog
        candidate={adoptCandidate}
        onOpenChange={setAdoptOpen}
        onSubmit={async (body) => {
          await adopt.mutateAsync(body);
        }}
        open={adoptOpen}
        returnFocusRef={dialogReturnRef}
      />

      <ConfirmDialog
        title="Skill 승격"
        description={`'${promoteTarget?.name ?? ""}' Skill의 상태를 바꿉니다. 프로덕션 승격은 정책·보안 게이트를 모두 통과해야 합니다.`}
        confirmLabel="승격"
        requireReason
        open={promoteTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setPromoteTarget(undefined);
        }}
        onConfirm={async (reason) => {
          if (promoteTarget) {
            await promote.mutateAsync({
              name: promoteTarget.name,
              to_status: promoteStatus,
              note: reason,
            });
          }
        }}
        returnFocusRef={rowTriggerRef}
      >
        <label className="agents-toolbar-field" htmlFor="promote-status">
          <span>전환할 상태</span>
          <Select
            id="promote-status"
            value={promoteStatus}
            options={allowedSkillTransitions(promoteTarget?.status).map((value) => ({
              value,
              label: skillStatusLabels[value] ?? value,
            }))}
            onChange={(event) => setPromoteStatus(event.target.value)}
          />
        </label>
      </ConfirmDialog>

      <ConfirmDialog
        title="Skill 삭제"
        description={`'${deleteTarget?.name ?? ""}' Skill을 삭제합니다. 이 작업은 되돌릴 수 없습니다.`}
        confirmLabel="삭제"
        tone="danger"
        open={deleteTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(undefined);
        }}
        onConfirm={async () => {
          if (deleteTarget) await remove.mutateAsync(deleteTarget.name);
        }}
        returnFocusRef={rowTriggerRef}
      />
    </div>
  );
}
