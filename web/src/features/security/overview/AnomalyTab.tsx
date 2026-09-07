import { useQuery } from "@tanstack/react-query";

import { QuerySection, ScopeNotice } from "@/features/security/security-ui";
import {
  anomalyDirectionLabel,
  anomalyThreshold,
  anomalyThresholds,
  anomalyWindowLabels,
  anomalyWindows,
  isAnomalyWindow,
} from "@/features/security/overview/security-overview";
import { apiClient } from "@/shared/api/client";
import type {
  AnomaliesQuery,
  AnomalyEvent,
  AnomalyFinding,
  CostAnomaly,
} from "@/shared/api/domains/security";
import { endpoints } from "@/shared/api/endpoints";
import { FormField } from "@/shared/components/form/FormField";
import { Badge } from "@/shared/components/ui/Badge";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime, formatNumber, formatRelative } from "@/shared/utils/format";

function directionTone(direction: string): "danger" | "info" {
  return direction === "up" ? "danger" : "info";
}

function findingColumns(): ReadonlyArray<DataTableColumn<AnomalyFinding>> {
  const column = createDataTableColumnHelper<AnomalyFinding>();
  return column.columns([
    column.accessor((row) => row.model, { id: "model", header: "모델" }),
    column.accessor((row) => row.metric, { id: "metric", header: "지표" }),
    column.accessor((row) => row.direction, {
      id: "direction",
      header: "방향",
      cell: ({ getValue }) => (
        <Badge tone={directionTone(getValue())}>{anomalyDirectionLabel(getValue())}</Badge>
      ),
    }),
    column.accessor((row) => row.baseline_mean, {
      id: "baseline",
      header: "기준 평균",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue(), 2)}</span>,
    }),
    column.accessor((row) => row.recent_mean, {
      id: "recent",
      header: "최근 평균",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue(), 2)}</span>,
    }),
    column.accessor((row) => row.z_score, {
      id: "z",
      header: "z 점수",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue(), 2)}</span>,
    }),
    column.accessor((row) => row.recent_samples, {
      id: "samples",
      header: "최근 표본",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
  ]) as Array<DataTableColumn<AnomalyFinding>>;
}

function costColumns(): ReadonlyArray<DataTableColumn<CostAnomaly>> {
  const column = createDataTableColumnHelper<CostAnomaly>();
  return column.columns([
    column.accessor((row) => row.scope, { id: "scope", header: "범위" }),
    column.accessor((row) => row.scope_value, {
      id: "scope_value",
      header: "대상",
      cell: ({ getValue }) => <span className="cell-mono">{getValue() || "전체"}</span>,
    }),
    column.accessor((row) => row.direction, {
      id: "direction",
      header: "방향",
      cell: ({ getValue }) => (
        <Badge tone={directionTone(getValue())}>{anomalyDirectionLabel(getValue())}</Badge>
      ),
    }),
    column.accessor((row) => row.baseline_mean, {
      id: "baseline",
      header: "기준 평균",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue(), 2)}</span>,
    }),
    column.accessor((row) => row.recent_value, {
      id: "recent",
      header: "최근 값",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue(), 2)}</span>,
    }),
    column.accessor((row) => row.z_score, {
      id: "z",
      header: "z 점수",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue(), 2)}</span>,
    }),
  ]) as Array<DataTableColumn<CostAnomaly>>;
}

function eventColumns(): ReadonlyArray<DataTableColumn<AnomalyEvent>> {
  const column = createDataTableColumnHelper<AnomalyEvent>();
  return column.columns([
    column.accessor((row) => row.created_at, {
      id: "created_at",
      header: "시각",
      cell: ({ getValue }) => <time title={formatDateTime(getValue())}>{formatRelative(getValue())}</time>,
    }),
    column.accessor((row) => `${row.scope} ${row.scope_value}`.trim(), {
      id: "scope",
      header: "대상",
      cell: ({ getValue }) => <span className="cell-mono">{getValue() || "—"}</span>,
    }),
    column.accessor((row) => row.metric, { id: "metric", header: "지표" }),
    column.accessor((row) => row.severity, {
      id: "severity",
      header: "심각도",
      cell: ({ getValue }) => (
        <Badge tone={getValue() === "critical" ? "danger" : "warning"}>{getValue() || "—"}</Badge>
      ),
    }),
    column.accessor((row) => row.value, {
      id: "value",
      header: "값",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue(), 2)}</span>,
    }),
    column.accessor((row) => row.status, { id: "status", header: "상태" }),
  ]) as Array<DataTableColumn<AnomalyEvent>>;
}

interface AnomalyTabProps {
  canRead: boolean;
  refreshInterval: number | false;
}

export function AnomalyTab({ canRead, refreshInterval }: AnomalyTabProps): React.JSX.Element {
  const [params, updateSearch] = useSearchState();
  const requestedRecent = params.get("recent");
  const recent = isAnomalyWindow(requestedRecent) ? requestedRecent : "6h";
  const threshold = anomalyThreshold(params.get("z"));

  const query: AnomaliesQuery = { recent, z: threshold, record: "0", limit: 100 };
  const anomalies = useQuery({
    queryKey: ["security", "anomalies", recent, threshold],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.security.anomalies, {
        query,
        signal,
        routeId: "security.overview",
      }),
    enabled: canRead,
    refetchInterval: refreshInterval,
    refetchIntervalInBackground: false,
  });

  if (!canRead) return <ScopeNotice scope="costs:read" what="이상 탐지 결과" />;

  const data = anomalies.data;

  return (
    <>
      <Toolbar label="이상 탐지 조건">
        <FormField label="비교 구간">
          {(control) => (
            <Select
              {...control}
              value={recent}
              onChange={(event) => updateSearch({ recent: event.target.value })}
            >
              {anomalyWindows.map((value) => (
                <option key={value} value={value}>
                  {anomalyWindowLabels[value]}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="z 임계값">
          {(control) => (
            <Select
              {...control}
              value={String(threshold)}
              onChange={(event) => updateSearch({ z: event.target.value })}
            >
              {anomalyThresholds.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </Toolbar>

      <InlineNotice tone="info" title="읽기 전용 조회">
        이 화면은 탐지 결과를 기록하거나 알림을 보내지 않고 조회만 합니다.
      </InlineNotice>

      <QuerySection
        error={anomalies.isError ? anomalies.error : undefined}
        hasData={Boolean(data)}
        label="이상 탐지 결과"
        onRetry={() => void anomalies.refetch()}
        pending={anomalies.isPending}
      >
        <StatGrid label="이상 탐지 요약">
          <StatCard label="모델 이상" tone="warning" value={formatNumber(data?.anomalies.length ?? 0)} />
          <StatCard label="비용 이상" tone="warning" value={formatNumber(data?.cost_anomalies.length ?? 0)} />
          <StatCard label="이번 탐지" value={formatNumber(data?.detected_events.length ?? 0)} />
          <StatCard label="적용 z 임계값" value={formatNumber(data?.z_threshold ?? threshold, 2)} />
        </StatGrid>

        <SectionCard
          title="모델 지표 이상"
          description="기준 구간 평균과 비교해 z 점수를 넘은 모델 지표입니다."
        >
          <DataTable
            caption="모델 지표 이상"
            columns={findingColumns()}
            data={data?.anomalies ?? []}
            emptyMessage="임계값을 넘은 모델 지표가 없습니다."
            getRowId={(row, index) => `${row.model}-${row.metric}-${index}`}
          />
        </SectionCard>

        <SectionCard title="비용 이상" description="팀·키·모델 단위 비용 급증 신호입니다.">
          <DataTable
            caption="비용 이상"
            columns={costColumns()}
            data={data?.cost_anomalies ?? []}
            emptyMessage="임계값을 넘은 비용 신호가 없습니다."
            getRowId={(row, index) => `${row.scope}-${row.scope_value}-${index}`}
          />
        </SectionCard>

        <SectionCard title="기록된 이상 이벤트" description="이전에 기록되어 알림이 발송된 이벤트입니다.">
          <DataTable
            caption="기록된 이상 이벤트"
            columns={eventColumns()}
            data={data?.events ?? []}
            emptyMessage="기록된 이상 이벤트가 없습니다."
            getRowId={(row, index) => row.id || `event-${index}`}
          />
        </SectionCard>
      </QuerySection>
    </>
  );
}
