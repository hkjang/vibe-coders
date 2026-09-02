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

const healthPresentation: Record<ProviderHealthState, { label: string; tone: BadgeProps["tone"] }> = {
  checking: { label: "Checking", tone: "info" },
  healthy: { label: "Healthy", tone: "success" },
  degraded: { label: "Degraded", tone: "warning" },
  unknown: { label: "Unknown", tone: "muted" },
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
  return (
    <div className="provider-query-warning" role="alert">
      <AlertTriangle aria-hidden="true" />
      <div>
        <strong>
          {label}{" "}
          {hasPreviousData ? "갱신에 실패해 마지막 정상 데이터를 표시합니다." : "조회에 실패했습니다."}
        </strong>
        <p>{isAppError(error) ? error.message : "잠시 후 다시 시도해 주세요."}</p>
        {requestId ? <code>Request ID: {requestId}</code> : null}
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
      header: "Provider",
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
      header: "Model Patterns",
      cell: ({ getValue }) => <code className="provider-patterns">{getValue() || "모든 모델"}</code>,
    }),
    column.accessor((row) => row.provider.failover_group, {
      id: "failover",
      header: "Failover / Priority",
      cell: ({ getValue, row }) => `${getValue() || "-"} / ${formatInteger(row.original.provider.priority)}`,
    }),
    column.accessor((row) => row.provider.timeout_ms, {
      id: "timeout",
      header: "Timeout",
      cell: ({ getValue }) => `${formatInteger(getValue())} ms`,
    }),
    column.accessor((row) => row.provider.api_key_configured, {
      id: "secret",
      header: "Secret",
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
          <h2 id="provider-list-title">Provider 목록</h2>
          <p>{formatInteger(filteredRowCount)}개 결과 · 우선순위가 낮은 Provider부터 표시합니다.</p>
        </div>
        {updatedAt > 0 ? <UpdatedTime timestamp={updatedAt} /> : null}
      </header>
      {providerUnavailable ? (
        <div className="provider-list-unavailable">
          <ServerCog aria-hidden="true" />
          <strong>마지막 정상 Provider 목록이 없습니다.</strong>
          <span>위 오류의 Request ID를 확인하고 목록 조회를 다시 시도하세요.</span>
        </div>
      ) : (
        <DataTable
          caption="Provider 연결 설정과 운영 상태"
          columns={columns}
          data={rows}
          emptyMessage={
            allRowCount === 0
              ? "등록된 Provider가 없습니다. Provider 등록은 Legacy 설정에서 수행할 수 있습니다."
              : "검색 및 필터 조건에 맞는 Provider가 없습니다."
          }
          getRowActionLabel={(row) => `${row.displayName} Provider 상세 열기`}
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
