import { Boxes, TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";

import { modelRowKey, type ModelCatalogRow } from "@/features/gateway/models/model-catalog";
import { modelSourceLabels, modelStatusPresentation } from "@/features/gateway/models/model-presentation";
import { formatInteger, formatKRW, formatPercent } from "@/features/health/health-utils";
import { UpdatedTime } from "@/features/health/health-ui";
import { Badge } from "@/shared/components/ui/Badge";
import { providerDisplayLabel } from "@/shared/api/provider-ref";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { operationalMessage } from "@/shared/errors/operational-messages";

function StatusBadges({ row }: { row: ModelCatalogRow }): React.JSX.Element {
  const { status } = row;
  const presentation = modelStatusPresentation[status];
  return (
    <div className="model-status-badges">
      <Badge tone={presentation.tone}>{presentation.label}</Badge>
      {row.model.stale && status !== "stale" ? <Badge tone="warning">마지막 정상 카탈로그</Badge> : null}
    </div>
  );
}

export interface ModelEnrichmentLoading {
  pricing: boolean;
  quality: boolean;
  tags: boolean;
}

function createModelColumns(
  detailSearch: (row: ModelCatalogRow) => string,
  rememberTrigger: (trigger: HTMLElement, modelKey: string) => void,
  enrichmentLoading: ModelEnrichmentLoading,
): ReadonlyArray<DataTableColumn<ModelCatalogRow>> {
  const column = createDataTableColumnHelper<ModelCatalogRow>();
  return column.columns([
    column.accessor((row) => row.model.id, {
      id: "model",
      header: "모델",
      cell: ({ row }) => {
        const key = modelRowKey(row.original.model);
        return (
          <div className="model-name-cell">
            <Link
              data-model-trigger={key}
              to={{ search: detailSearch(row.original) }}
              onClick={(event) => rememberTrigger(event.currentTarget, key)}
            >
              {row.original.model.id}
            </Link>
            <span>{row.original.model.owned_by || "소유자 미상"}</span>
          </div>
        );
      },
    }),
    column.accessor((row) => row.providerLabel, {
      id: "provider",
      header: "공급자",
      cell: ({ getValue, row }) => (
        <div className="model-provider-cell">
          <strong>{getValue()}</strong>
          <span>{modelSourceLabels[row.original.model.source]}</span>
        </div>
      ),
    }),
    column.accessor((row) => row.status, {
      id: "status",
      header: "상태",
      cell: ({ row }) => <StatusBadges row={row.original} />,
    }),
    column.accessor((row) => row.quality?.quality_score, {
      id: "quality",
      header: "품질",
      cell: ({ getValue }) => {
        const value = getValue();
        return value === undefined
          ? enrichmentLoading.quality
            ? "확인 중"
            : "-"
          : `${formatInteger(value)}점`;
      },
    }),
    column.accessor((row) => row.quality?.success_rate, {
      id: "success",
      header: "성공률",
      cell: ({ getValue }) => {
        const value = getValue();
        return value === undefined ? (enrichmentLoading.quality ? "확인 중" : "-") : formatPercent(value);
      },
    }),
    column.accessor((row) => row.price?.input_krw_per_1m, {
      id: "input-price",
      header: "입력 / 100만 토큰",
      cell: ({ getValue }) => {
        const value = getValue();
        return value === undefined ? (enrichmentLoading.pricing ? "확인 중" : "-") : formatKRW(value);
      },
    }),
    column.accessor((row) => row.price?.output_krw_per_1m, {
      id: "output-price",
      header: "출력 / 100만 토큰",
      cell: ({ getValue }) => {
        const value = getValue();
        return value === undefined ? (enrichmentLoading.pricing ? "확인 중" : "-") : formatKRW(value);
      },
    }),
    column.accessor((row) => row.tag?.good_for, {
      id: "good-for",
      header: "적합한 용도",
      cell: ({ getValue }) => (
        <span className="model-tag-summary">{getValue() || (enrichmentLoading.tags ? "확인 중" : "-")}</span>
      ),
    }),
  ]) as Array<DataTableColumn<ModelCatalogRow>>;
}

interface ModelTableProps {
  allRowCount: number;
  catalogueAvailable: boolean;
  detailSearch: (row: ModelCatalogRow) => string;
  enrichmentLoading: ModelEnrichmentLoading;
  filteredRowCount: number;
  loading: boolean;
  modelUnavailable: boolean;
  onPageChange: (pageIndex: number) => void;
  onRowClick: (row: ModelCatalogRow) => void;
  pageCount: number;
  pageIndex: number;
  rememberTrigger: (trigger: HTMLElement, modelKey: string) => void;
  rows: readonly ModelCatalogRow[];
  updatedAt: number;
}

export function ModelTable({
  allRowCount,
  catalogueAvailable,
  detailSearch,
  enrichmentLoading,
  filteredRowCount,
  loading,
  modelUnavailable,
  onPageChange,
  onRowClick,
  pageCount,
  pageIndex,
  rememberTrigger,
  rows,
  updatedAt,
}: ModelTableProps): React.JSX.Element {
  const columns = useMemo(
    () => createModelColumns(detailSearch, rememberTrigger, enrichmentLoading),
    [detailSearch, enrichmentLoading, rememberTrigger],
  );
  return (
    <section className="model-list-section" aria-labelledby="model-list-title">
      <header>
        <div>
          <h2 id="model-list-title">모델 목록</h2>
          <p>
            {catalogueAvailable
              ? `${formatInteger(filteredRowCount)}개 결과 · 공급자와 모델 ID 기준으로 표시합니다.`
              : modelUnavailable
                ? "모델 목록을 불러올 수 없습니다."
                : "모델 목록을 불러오는 중입니다."}
          </p>
        </div>
        {updatedAt > 0 ? <UpdatedTime timestamp={updatedAt} /> : null}
      </header>
      {modelUnavailable ? (
        <div className="model-list-unavailable">
          <Boxes aria-hidden="true" />
          <strong>마지막 정상 모델 목록이 없습니다.</strong>
          <span>위 오류의 요청 ID를 확인하고 목록 조회를 다시 시도하세요.</span>
        </div>
      ) : (
        <DataTable
          caption="공급자별 모델 상태, 품질과 가격"
          columns={columns}
          data={rows}
          emptyMessage={
            allRowCount === 0
              ? "조회 가능한 모델이 없습니다. 공급자 연결과 모델 라우트를 확인하세요."
              : "검색 및 필터 조건에 맞는 모델이 없습니다."
          }
          getRowActionLabel={(row) => `${row.providerLabel} ${row.model.id} 모델 상세 열기`}
          getRowId={(row) => modelRowKey(row.model)}
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

export function ModelPartialFailureNotice({
  failures,
  requestId,
}: {
  failures: readonly { code: string; message: string; provider: string; provider_ref: string }[];
  requestId: string;
}): React.JSX.Element | null {
  if (failures.length === 0) return null;
  return (
    <div className="model-partial-warning" role="alert">
      <TriangleAlert aria-hidden="true" />
      <div>
        <strong>일부 공급자의 모델 목록을 갱신하지 못했습니다.</strong>
        <ul>
          {failures.map((failure) => (
            <li key={`${failure.provider_ref}-${failure.code}`}>
              <strong>{providerDisplayLabel(failure.provider, failure.provider_ref)}</strong> ·{" "}
              {operationalMessage(failure.code, "모델 카탈로그 일부를 확인할 수 없습니다.")} ({failure.code})
            </li>
          ))}
        </ul>
        {requestId ? <code>요청 ID: {requestId}</code> : null}
      </div>
    </div>
  );
}
