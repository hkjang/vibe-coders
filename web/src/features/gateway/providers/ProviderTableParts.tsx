import { AlertTriangle, RefreshCw, ServerCog } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";

import {
  displayProviderBaseURL,
  type ProviderCatalogRow,
  type ProviderHealthState,
} from "@/features/gateway/providers/provider-catalog";
import { formatInteger, formatMilliseconds } from "@/features/health/health-utils";
import { UpdatedTime } from "@/features/health/health-ui";
import { isAppError } from "@/shared/api/error";
import { Badge, type BadgeProps } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { healthStatusLabels } from "@/config/ui-labels";

const healthPresentation: Record<ProviderHealthState, { label: string; tone: BadgeProps["tone"] }> = {
  checking: { label: healthStatusLabels.checking, tone: "info" },
  healthy: { label: healthStatusLabels.healthy, tone: "success" },
  degraded: { label: healthStatusLabels.degraded, tone: "warning" },
  unknown: { label: healthStatusLabels.unknown, tone: "muted" },
};

export function QueryFailureNotice({
  error,
  hasPreviousData,
  label,
  onRetry,
}: {
  error: unknown;
  hasPreviousData: boolean;
  label: string;
  onRetry: () => void;
}): React.JSX.Element {
  const requestId = isAppError(error) ? error.requestId : undefined;
  const diagnosticCode = isAppError(error) ? error.code : undefined;
  return (
    <div className="provider-query-warning" role="alert">
      <AlertTriangle aria-hidden="true" />
      <div>
        <strong>
          {label}{" "}
          {hasPreviousData ? "갱신에 실패해 마지막 정상 데이터를 표시합니다." : "조회에 실패했습니다."}
        </strong>
        <p>{safeAppErrorMessage(error, `${label} 데이터를 확인할 수 없습니다.`)}</p>
        {requestId ? <code>요청 ID: {requestId}</code> : null}
        {diagnosticCode ? <code>진단 코드: {diagnosticCode}</code> : null}
      </div>
      <Button size="small" variant="secondary" onClick={onRetry} aria-label={`${label} 재시도`}>
        <RefreshCw aria-hidden="true" /> 재시도
      </Button>
    </div>
  );
}

function ProviderHealthBadge({ health }: { health: ProviderHealthState }): React.JSX.Element {
  const presentation = healthPresentation[health];
  return <Badge tone={presentation.tone}>{presentation.label}</Badge>;
}

function createProviderColumns(
  detailSearch: (provider: string) => string,
  rememberTrigger: (trigger: HTMLElement, provider: string) => void,
): ReadonlyArray<DataTableColumn<ProviderCatalogRow>> {
  const column = createDataTableColumnHelper<ProviderCatalogRow>();
  return column.columns([
    column.accessor((row) => row.displayName, {
      id: "provider",
      header: "공급자",
      cell: ({ row }) => (
        <div className="provider-name-cell">
          <Link
            data-provider-trigger={row.original.identity}
            to={{ search: detailSearch(row.original.identity) }}
            onClick={(event) => rememberTrigger(event.currentTarget, row.original.identity)}
          >
            {row.original.displayName}
          </Link>
          <span>{displayProviderBaseURL(row.original.provider.base_url)}</span>
        </div>
      ),
    }),
    column.accessor((row) => row.provider.enabled, {
      id: "enabled",
      header: "설정 상태",
      cell: ({ getValue }) => (
        <Badge tone={getValue() ? "success" : "muted"}>{getValue() ? "활성" : "비활성"}</Badge>
      ),
    }),
    column.accessor((row) => row.health, {
      id: "health",
      header: "운영 상태",
      cell: ({ getValue }) => <ProviderHealthBadge health={getValue()} />,
    }),
    column.accessor((row) => row.routing?.p95_latency_ms, {
      id: "latency",
      header: "P95 지연",
      cell: ({ getValue, row }) => {
        const value = getValue() ?? row.original.evaluation?.metrics.p95_latency_ms.actual;
        if (row.original.health === "checking") return "확인 중";
        return value === undefined || row.original.health === "unknown" ? "-" : formatMilliseconds(value);
      },
    }),
    column.accessor((row) => row.provider.model_patterns, {
      id: "patterns",
      header: "모델 패턴",
      cell: ({ getValue }) => <code className="provider-patterns">{getValue() || "모든 모델"}</code>,
    }),
    column.accessor((row) => row.provider.failover_group, {
      id: "failover",
      header: "장애 전환 / 우선순위",
      cell: ({ getValue, row }) => `${getValue() || "-"} / ${formatInteger(row.original.provider.priority)}`,
    }),
    column.accessor((row) => row.provider.timeout_ms, {
      id: "timeout",
      header: "제한 시간",
      cell: ({ getValue }) => `${formatInteger(getValue())} ms`,
    }),
    column.accessor((row) => row.provider.api_key_configured, {
      id: "secret",
      header: "비밀정보",
      cell: ({ getValue }) => (getValue() ? "설정됨" : "없음"),
    }),
  ]) as Array<DataTableColumn<ProviderCatalogRow>>;
}

interface ProviderTableProps {
  allRowCount: number;
  detailSearch: (provider: string) => string;
  filteredRowCount: number;
  loading: boolean;
  onPageChange: (pageIndex: number) => void;
  onRowClick: (row: ProviderCatalogRow) => void;
  pageCount: number;
  pageIndex: number;
  providerUnavailable: boolean;
  rememberTrigger: (trigger: HTMLElement, provider: string) => void;
  rows: readonly ProviderCatalogRow[];
  updatedAt: number;
}

export function ProviderTable({
  allRowCount,
  detailSearch,
  filteredRowCount,
  loading,
  onPageChange,
  onRowClick,
  pageCount,
  pageIndex,
  providerUnavailable,
  rememberTrigger,
  rows,
  updatedAt,
}: ProviderTableProps): React.JSX.Element {
  const columns = useMemo(
    () => createProviderColumns(detailSearch, rememberTrigger),
    [detailSearch, rememberTrigger],
  );
  return (
    <section className="provider-list-section" aria-labelledby="provider-list-title">
      <header>
        <div>
          <h2 id="provider-list-title">공급자 목록</h2>
          <p>{formatInteger(filteredRowCount)}개 결과 · 우선순위가 낮은 공급자부터 표시합니다.</p>
        </div>
        {updatedAt > 0 ? <UpdatedTime timestamp={updatedAt} /> : null}
      </header>
      {providerUnavailable ? (
        <div className="provider-list-unavailable">
          <ServerCog aria-hidden="true" />
          <strong>마지막 정상 공급자 목록이 없습니다.</strong>
          <span>위 오류의 요청 ID를 확인하고 목록 조회를 다시 시도하세요.</span>
        </div>
      ) : (
        <DataTable
          caption="공급자 연결 설정과 운영 상태"
          columns={columns}
          data={rows}
          emptyMessage={
            allRowCount === 0
              ? "등록된 공급자가 없습니다. 공급자 등록은 기존 설정 화면에서 수행할 수 있습니다."
              : "검색 및 필터 조건에 맞는 공급자가 없습니다."
          }
          getRowActionLabel={(row) => `${row.displayName} 공급자 상세 열기`}
          getRowId={(row) => row.identity}
          loading={loading}
          onPageChange={onPageChange}
          onRowClick={onRowClick}
          pageCount={pageCount}
          pageIndex={pageIndex}
        />
      )}
    </section>
  );
}
