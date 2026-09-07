import { useQueries } from "@tanstack/react-query";
import { useMemo, useRef } from "react";

import { ProfileDetailSheet } from "@/features/governance/assets/ProfileDetailSheet";
import { PanelFailure, ScoreBars } from "@/features/governance/reports/report-parts";
import { riskTone, severityTone, type ReportWindow } from "@/features/governance/reports/report-window";
import { apiClient } from "@/shared/api/client";
import type {
  AdoptionRow,
  CoachingItem,
  McpAffinityItem,
  ModelAffinityItem,
  PersonalProfile,
  Text2SqlHintItem,
} from "@/shared/api/domains/governance-reports";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";

const listLimit = 50;
const hintMinCount = 3;

function profileColumns(): ReadonlyArray<DataTableColumn<PersonalProfile>> {
  const column = createDataTableColumnHelper<PersonalProfile>();
  return column.columns([
    column.accessor((row) => row.user_id, {
      id: "user",
      header: "사용자",
      cell: ({ row }) => (
        <span className="mono truncate" title={row.original.user_id}>
          {row.original.user_id}
        </span>
      ),
    }),
    column.accessor((row) => row.team, { id: "team", header: "팀" }),
    column.accessor((row) => row.role, { id: "role", header: "역할" }),
    column.accessor((row) => row.requests, {
      id: "requests",
      header: "요청",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.requests)}</span>,
    }),
    column.accessor((row) => row.total_cost_krw, {
      id: "cost",
      header: "총비용",
      cell: ({ row }) => <span className="cell-number">{formatKRW(row.original.total_cost_krw)}</span>,
    }),
    column.accessor((row) => row.success_rate, {
      id: "success_rate",
      header: "성공률",
      cell: ({ row }) => <span className="cell-number">{formatPercent(row.original.success_rate)}</span>,
    }),
    column.accessor((row) => row.cache_rate, {
      id: "cache_rate",
      header: "캐시",
      cell: ({ row }) => <span className="cell-number">{formatPercent(row.original.cache_rate)}</span>,
    }),
    column.accessor((row) => row.mcp_usage_rate, {
      id: "mcp_rate",
      header: "MCP",
      cell: ({ row }) => <span className="cell-number">{formatPercent(row.original.mcp_usage_rate)}</span>,
    }),
    column.accessor((row) => row.risk_score, {
      id: "risk",
      header: "위험",
      cell: ({ row }) => (
        <Badge tone={riskTone(row.original.risk_score)}>{formatNumber(row.original.risk_score)}</Badge>
      ),
    }),
    column.accessor((row) => row.top_models[0]?.key ?? "", {
      id: "top_model",
      header: "대표 모델",
      cell: ({ row }) => row.original.top_models[0]?.key ?? "—",
    }),
    column.accessor((row) => row.summary, {
      id: "summary",
      header: "요약",
      cell: ({ row }) => (
        <span className="truncate" title={row.original.summary}>
          {row.original.summary || "—"}
        </span>
      ),
    }),
  ]);
}

function coachingColumns(): ReadonlyArray<DataTableColumn<CoachingItem>> {
  const column = createDataTableColumnHelper<CoachingItem>();
  return column.columns([
    column.accessor((row) => row.user_id, {
      id: "user",
      header: "사용자",
      cell: ({ row }) => <span className="mono truncate">{row.original.user_id}</span>,
    }),
    column.accessor((row) => row.team, { id: "team", header: "팀" }),
    column.accessor((row) => row.category, { id: "category", header: "분류" }),
    column.accessor((row) => row.score, {
      id: "score",
      header: "점수",
      cell: ({ row }) => <span className="cell-number">{formatNumber(Math.round(row.original.score))}</span>,
    }),
    column.accessor((row) => row.severity, {
      id: "severity",
      header: "심각도",
      cell: ({ row }) => <Badge tone={severityTone(row.original.severity)}>{row.original.severity}</Badge>,
    }),
    column.accessor((row) => row.title, { id: "title", header: "제목" }),
    column.accessor((row) => row.reason, {
      id: "reason",
      header: "근거",
      cell: ({ row }) => (
        <span className="truncate" title={row.original.reason}>
          {row.original.reason || "—"}
        </span>
      ),
    }),
    column.accessor((row) => row.detail, {
      id: "detail",
      header: "권장 코칭",
      cell: ({ row }) => (
        <span className="truncate" title={row.original.detail}>
          {row.original.detail || "—"}
        </span>
      ),
    }),
  ]);
}

function hintColumns(): ReadonlyArray<DataTableColumn<Text2SqlHintItem>> {
  const column = createDataTableColumnHelper<Text2SqlHintItem>();
  return column.columns([
    column.accessor((row) => row.user_id, {
      id: "user",
      header: "사용자",
      cell: ({ row }) => <span className="mono truncate">{row.original.user_id}</span>,
    }),
    column.accessor((row) => row.team, { id: "team", header: "팀" }),
    column.accessor((row) => row.hint_type || row.recommended_product, { id: "hint", header: "힌트" }),
    column.accessor((row) => row.schema_name, { id: "schema", header: "스키마" }),
    column.accessor((row) => row.count, {
      id: "count",
      header: "반복",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.count)}</span>,
    }),
    column.accessor((row) => row.success_rate, {
      id: "success_rate",
      header: "성공률",
      cell: ({ row }) => <span className="cell-number">{formatPercent(row.original.success_rate)}</span>,
    }),
    column.accessor((row) => row.avg_cost_krw, {
      id: "avg_cost",
      header: "평균비용",
      cell: ({ row }) => <span className="cell-number">{formatKRW(row.original.avg_cost_krw)}</span>,
    }),
    column.accessor((row) => row.estimated_savings_krw, {
      id: "savings",
      header: "절감 추정",
      cell: ({ row }) => <span className="cell-number">{formatKRW(row.original.estimated_savings_krw)}</span>,
    }),
    column.accessor((row) => row.reason, {
      id: "reason",
      header: "근거",
      cell: ({ row }) => (
        <span className="truncate" title={row.original.reason}>
          {row.original.reason || "—"}
        </span>
      ),
    }),
  ]);
}

function adoptionColumns(): ReadonlyArray<DataTableColumn<AdoptionRow>> {
  const column = createDataTableColumnHelper<AdoptionRow>();
  return column.columns([
    column.accessor((row) => row.kind, { id: "kind", header: "추천 종류" }),
    column.accessor((row) => row.adopted, {
      id: "adopted",
      header: "채택",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.adopted)}</span>,
    }),
    column.accessor((row) => row.dismissed, {
      id: "dismissed",
      header: "거절",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.dismissed)}</span>,
    }),
    column.accessor((row) => row.distinct_adopters, {
      id: "adopters",
      header: "채택자",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.distinct_adopters)}</span>,
    }),
    column.accessor((row) => row.adoption_rate, {
      id: "rate",
      header: "채택률",
      cell: ({ row }) => <span className="cell-number">{formatPercent(row.original.adoption_rate)}</span>,
    }),
  ]);
}

function modelAffinityColumns(): ReadonlyArray<DataTableColumn<ModelAffinityItem>> {
  const column = createDataTableColumnHelper<ModelAffinityItem>();
  return column.columns([
    column.accessor((row) => row.user_id, {
      id: "user",
      header: "사용자",
      cell: ({ row }) => <span className="mono truncate">{row.original.user_id}</span>,
    }),
    column.accessor((row) => row.team, { id: "team", header: "팀" }),
    column.accessor((row) => row.model, { id: "model", header: "모델" }),
    column.accessor((row) => row.score, {
      id: "score",
      header: "점수",
      cell: ({ row }) => <span className="cell-number">{formatNumber(Math.round(row.original.score))}</span>,
    }),
    column.accessor((row) => row.requests, {
      id: "requests",
      header: "요청",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.requests)}</span>,
    }),
    column.accessor((row) => row.success_rate, {
      id: "success_rate",
      header: "성공률",
      cell: ({ row }) => <span className="cell-number">{formatPercent(row.original.success_rate)}</span>,
    }),
    column.accessor((row) => row.avg_cost_krw, {
      id: "avg_cost",
      header: "평균비용",
      cell: ({ row }) => <span className="cell-number">{formatKRW(row.original.avg_cost_krw)}</span>,
    }),
  ]);
}

function mcpAffinityColumns(): ReadonlyArray<DataTableColumn<McpAffinityItem>> {
  const column = createDataTableColumnHelper<McpAffinityItem>();
  return column.columns([
    column.accessor((row) => row.user_id, {
      id: "user",
      header: "사용자",
      cell: ({ row }) => <span className="mono truncate">{row.original.user_id}</span>,
    }),
    column.accessor((row) => row.team, { id: "team", header: "팀" }),
    column.accessor((row) => row.ref || `${row.server_label}/${row.tool_name}`, {
      id: "tool",
      header: "도구",
    }),
    column.accessor((row) => row.score, {
      id: "score",
      header: "점수",
      cell: ({ row }) => <span className="cell-number">{formatNumber(Math.round(row.original.score))}</span>,
    }),
    column.accessor((row) => row.calls, {
      id: "calls",
      header: "호출",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.calls)}</span>,
    }),
    column.accessor((row) => row.errors, {
      id: "errors",
      header: "오류",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.errors)}</span>,
    }),
    column.accessor((row) => row.success_rate, {
      id: "success_rate",
      header: "성공률",
      cell: ({ row }) => <span className="cell-number">{formatPercent(row.original.success_rate)}</span>,
    }),
    column.accessor((row) => row.avg_request_latency_ms, {
      id: "latency",
      header: "평균 지연",
      cell: ({ row }) => (
        <span className="cell-number">{formatNumber(Math.round(row.original.avg_request_latency_ms))}ms</span>
      ),
    }),
  ]);
}

export function PersonalizationTab({
  onSelectUser,
  refetchInterval,
  selectedUser,
  window: reportWindow,
}: {
  onSelectUser: (userId: string) => void;
  refetchInterval: number | false;
  selectedUser: string;
  window: ReportWindow;
}): React.JSX.Element {
  const profileCols = useMemo(() => profileColumns(), []);
  const coachingCols = useMemo(() => coachingColumns(), []);
  const hintCols = useMemo(() => hintColumns(), []);
  const adoptionCols = useMemo(() => adoptionColumns(), []);
  const modelCols = useMemo(() => modelAffinityColumns(), []);
  const mcpCols = useMemo(() => mcpAffinityColumns(), []);
  const rowTriggerRef = useRef<HTMLElement | null>(null);

  const shared = { refetchInterval, refetchIntervalInBackground: false } as const;
  const personalization = endpoints.domains.governanceReports.personalization;
  const [profiles, coaching, hints, adoption, modelAffinity, mcpAffinity] = useQueries({
    queries: [
      {
        queryKey: ["governance", "personalization", "profiles", reportWindow],
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          apiClient.request(personalization.profiles, {
            query: { window: reportWindow, limit: listLimit },
            signal,
            routeId: "governance.assets",
          }),
        ...shared,
      },
      {
        queryKey: ["governance", "personalization", "coaching", reportWindow],
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          apiClient.request(personalization.coaching, {
            query: { window: reportWindow, limit: listLimit },
            signal,
            routeId: "governance.assets",
          }),
        ...shared,
      },
      {
        queryKey: ["governance", "personalization", "text2sql-hints", reportWindow],
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          apiClient.request(personalization.text2sqlHints, {
            query: { window: reportWindow, limit: listLimit, min_count: hintMinCount },
            signal,
            routeId: "governance.assets",
          }),
        ...shared,
      },
      {
        queryKey: ["governance", "personalization", "adoption", reportWindow],
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          apiClient.request(endpoints.domains.governanceReports.recommendationAdoption, {
            query: { window: reportWindow },
            signal,
            routeId: "governance.assets",
          }),
        ...shared,
      },
      {
        queryKey: ["governance", "personalization", "model-affinity", reportWindow],
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          apiClient.request(personalization.modelAffinity, {
            query: { window: reportWindow, limit: listLimit },
            signal,
            routeId: "governance.assets",
          }),
        ...shared,
      },
      {
        queryKey: ["governance", "personalization", "mcp-affinity", reportWindow],
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          apiClient.request(personalization.mcpAffinity, {
            query: { window: reportWindow, limit: listLimit },
            signal,
            routeId: "governance.assets",
          }),
        ...shared,
      },
    ],
  });

  const profileRows = profiles.data?.profiles ?? [];
  const coachingRows = coaching.data?.items ?? [];
  const hintRows = hints.data?.items ?? [];
  const adoptionRows = adoption.data?.by_kind ?? [];
  const modelRows = modelAffinity.data?.items ?? [];
  const mcpRows = mcpAffinity.data?.items ?? [];

  const totalRequests = profileRows.reduce((sum, profile) => sum + profile.requests, 0);
  const weightedSuccess = totalRequests
    ? profileRows.reduce((sum, profile) => sum + profile.requests * profile.success_rate, 0) / totalRequests
    : 0;
  const highRisk = profileRows.filter((profile) => profile.risk_score >= 70).length;
  const adopted = adoption.data?.total_adopted ?? 0;
  const dismissed = adoption.data?.total_dismissed ?? 0;
  const topAffinity = [...modelRows]
    .sort((left, right) => right.score - left.score)
    .slice(0, 8)
    .map((item) => ({
      label: `${item.user_id} · ${item.model}`,
      value: item.score,
      display: `${formatNumber(Math.round(item.score))}점`,
    }));

  const selectUser = (userId: string, trigger?: HTMLElement | null): void => {
    rowTriggerRef.current = trigger ?? null;
    onSelectUser(userId);
  };

  return (
    <div className="gov-stack">
      {profiles.isError ? (
        <PanelFailure error={profiles.error} label="개인화 프로필" onRetry={() => void profiles.refetch()} />
      ) : null}

      <StatGrid label="개인화 운영 요약">
        <StatCard label="프로필 사용자" value={formatNumber(profileRows.length)} />
        <StatCard label="총 요청" value={formatNumber(totalRequests)} />
        <StatCard label="가중 성공률" value={formatPercent(weightedSuccess)} />
        <StatCard
          label="고위험 사용자"
          tone={highRisk > 0 ? "danger" : "default"}
          value={formatNumber(highRisk)}
        />
        <StatCard label="코칭 후보" value={formatNumber(coachingRows.length)} />
        <StatCard
          label="추천 채택"
          value={formatNumber(adopted)}
          hint={`거절 ${formatNumber(dismissed)}건 · 채택률 ${formatPercent(adoption.data?.overall_adoption_rate ?? 0)}`}
        />
      </StatGrid>

      <SectionCard
        headingLevel={2}
        title="사용자 AI 프로필"
        description="사용자를 선택하면 상세 지표와 스냅샷 이력을 볼 수 있습니다. 원문 프롬프트는 포함되지 않습니다."
      >
        <DataTable
          caption="사용자 AI 프로필"
          columns={profileCols}
          data={profileRows}
          getRowId={(row, index) => row.user_id || `profile-${index}`}
          loading={profiles.isPending}
          error={
            profiles.isError
              ? safeAppErrorMessage(profiles.error, "개인화 프로필을 불러오지 못했습니다.")
              : undefined
          }
          onRetry={() => void profiles.refetch()}
          emptyMessage="표시할 프로필이 없습니다."
          getRowActionLabel={(row) => `${row.user_id} 프로필 상세 열기`}
          onRowClick={(row) => selectUser(row.user_id, document.activeElement as HTMLElement | null)}
        />
        {!profiles.isPending && !profiles.isError && profileRows.length === 0 ? (
          <EmptyState
            title="아직 개인화 프로필이 없습니다."
            description="사용자에게 매핑된 API 키로 호출이 기록되면 프로필이 생성됩니다."
          />
        ) : null}
      </SectionCard>

      <SectionCard
        headingLevel={2}
        title="개인화 코칭 후보"
        description="프로필 지표만으로 산출한 읽기 전용 코칭 후보입니다."
      >
        {coaching.isError ? (
          <PanelFailure error={coaching.error} label="코칭 후보" onRetry={() => void coaching.refetch()} />
        ) : null}
        <DataTable
          caption="개인화 코칭 후보"
          columns={coachingCols}
          data={coachingRows}
          getRowId={(row, index) => `${row.user_id}-${row.category}-${index}`}
          loading={coaching.isPending}
          emptyMessage="현재 코칭 후보가 없습니다."
        />
      </SectionCard>

      <SectionCard
        headingLevel={2}
        title="Text2SQL 개인 힌트"
        description="반복되는 Text2SQL 질문을 저장 리포트·데이터 상품 후보로 정리합니다. 질문 원문과 SQL은 표시하지 않습니다."
      >
        {hints.isError ? (
          <PanelFailure error={hints.error} label="Text2SQL 힌트" onRetry={() => void hints.refetch()} />
        ) : null}
        <DataTable
          caption="Text2SQL 개인 힌트"
          columns={hintCols}
          data={hintRows}
          getRowId={(row, index) => `${row.user_id}-${row.fingerprint}-${index}`}
          loading={hints.isPending}
          emptyMessage="표시할 Text2SQL 힌트가 없습니다."
        />
      </SectionCard>

      <SectionCard headingLevel={2} title="추천 채택률" description="사용자가 추천을 채택·거절한 결과입니다.">
        {adoption.isError ? (
          <PanelFailure error={adoption.error} label="추천 채택률" onRetry={() => void adoption.refetch()} />
        ) : null}
        <DataTable
          caption="추천 채택률"
          columns={adoptionCols}
          data={adoptionRows}
          getRowId={(row, index) => row.kind || `kind-${index}`}
          loading={adoption.isPending}
          emptyMessage="아직 추천 피드백이 없습니다."
        />
      </SectionCard>

      <SectionCard
        headingLevel={2}
        title="모델 Affinity"
        description="성공률·사용량·평균 비용으로 계산한 사용자별 모델 적합도입니다."
      >
        {modelAffinity.isError ? (
          <PanelFailure
            error={modelAffinity.error}
            label="모델 Affinity"
            onRetry={() => void modelAffinity.refetch()}
          />
        ) : null}
        {topAffinity.length > 0 ? <ScoreBars data={topAffinity} max={100} /> : null}
        <DataTable
          caption="모델 Affinity"
          columns={modelCols}
          data={modelRows}
          getRowId={(row, index) => `${row.user_id}-${row.model}-${index}`}
          loading={modelAffinity.isPending}
          emptyMessage="표시할 모델 affinity가 없습니다."
        />
      </SectionCard>

      <SectionCard
        headingLevel={2}
        title="MCP Affinity"
        description="호출수·성공률·평균 요청 지연으로 계산한 사용자별 MCP 도구 적합도입니다."
      >
        {mcpAffinity.isError ? (
          <PanelFailure
            error={mcpAffinity.error}
            label="MCP Affinity"
            onRetry={() => void mcpAffinity.refetch()}
          />
        ) : null}
        <DataTable
          caption="MCP Affinity"
          columns={mcpCols}
          data={mcpRows}
          getRowId={(row, index) => `${row.user_id}-${row.ref}-${index}`}
          loading={mcpAffinity.isPending}
          emptyMessage="표시할 MCP affinity가 없습니다."
        />
      </SectionCard>

      {selectedUser ? (
        <ProfileDetailSheet
          userId={selectedUser}
          window={reportWindow}
          returnFocusRef={rowTriggerRef}
          onClose={() => onSelectUser("")}
        />
      ) : null}
    </div>
  );
}
