import { DwSavingsPanel } from "./DwSavingsPanel";
import { Download } from "lucide-react";

import { InsightQueryStatus } from "./InsightQueryStatus";
import { DwTrendPanel } from "./DwTrendPanel";
import { DwDimensionsPanel } from "./DwDimensionsPanel";
import { dwBoundsLabel, type DwDateSelection } from "@/shared/utils/dw-date-bounds";
import { SimpleTable } from "@/features/data/SimpleTable";
import { downloadDwDashboardCsv } from "@/features/data/warehouse/export-dw-csv";
import { useInsightsQueries } from "@/features/data/warehouse/use-warehouse-queries";
import {
  dwBucketLabels,
  dwBuckets,
  dwDimensionLabels,
  dwDimensions,
  dwOrderLabels,
  dwOrders,
  dwWindowLabels,
  dwWindows,
  type DwBucket,
  type DwDimension,
  type DwOrder,
  type DwWindow,
} from "@/features/data/warehouse/warehouse-filters";
import type { DwLatencyModelRow } from "@/shared/api/domains/data.schemas";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { useFileDownload } from "@/shared/hooks/use-file-download";
import { formatDuration, formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";

interface InsightsTabProps {
  selection: DwDateSelection;
  bucket: DwBucket;
  dimension: DwDimension;
  onFilterChange: (updates: Record<string, string | undefined>) => void;
  order: DwOrder;
  range: DwWindow;
}

interface CountRow {
  label: string;
  count: number;
}

const countColumns = [
  { id: "label", header: "항목", cell: (row: CountRow) => row.label },
  {
    id: "count",
    header: "건수",
    cell: (row: CountRow) => <span className="cell-number">{formatNumber(row.count)}</span>,
  },
];

export function InsightsTab({
  selection,
  bucket,
  dimension,
  onFilterChange,
  order,
  range,
}: InsightsTabProps): React.JSX.Element {
  const { overview, timeseries, dimensions, latency, quality, routing, text2sql, savings, modelMigration } =
    useInsightsQueries(range, bucket, dimension, order, selection);
  const bounds = selection.kind === "selected" ? selection.bounds : undefined;
  const selectionReady =
    selection.kind === "none" ||
    (selection.kind === "selected" && timeseries.data?.date_bounds_supported === true);
  const csv = useFileDownload(
    "data.warehouse",
    JSON.stringify([range, bucket, dimension, order, selection]),
    Boolean(dimensions.data?.configured) && !dimensions.isError && selectionReady,
  );
  const exporting = csv.pending;
  const exportError = csv.error
    ? `${csv.error.message}${csv.error.requestId ? ` 요청 ID: ${csv.error.requestId}` : ""}`
    : undefined;
  const exportCsv = (): void => {
    void csv.run((ownership) => downloadDwDashboardCsv(range, dimension, order, ownership, bounds), {
      errorMessage: "CSV를 내보내지 못했습니다.",
      toastErrors: false,
    });
  };

  const summary = overview.data;
  const unavailable = overview.isPending || (overview.isError && !summary);
  const value = (input: number | undefined, render: (input: number) => string): string =>
    unavailable || input === undefined ? "—" : render(input);

  const evaluation = quality.data?.eval;
  const feedback = quality.data?.feedback;

  return (
    <div className="data-section-stack">
      <Toolbar
        label="데이터 웨어하우스 조회 조건"
        end={
          <Button variant="secondary" onClick={exportCsv} disabled={exporting || !csv.available}>
            <Download aria-hidden="true" /> {exporting ? "내보내는 중" : "CSV 내보내기"}
          </Button>
        }
      >
        <label className="data-filter" htmlFor="dw-window">
          <span>조회 구간</span>
          <Select
            id="dw-window"
            value={range}
            onChange={(event) => onFilterChange({ window: event.target.value })}
            options={dwWindows.map((item) => ({ value: item, label: dwWindowLabels[item] }))}
          />
        </label>
        <label className="data-filter" htmlFor="dw-bucket">
          <span>집계 단위</span>
          <Select
            id="dw-bucket"
            value={bucket}
            onChange={(event) => onFilterChange({ bucket: event.target.value })}
            options={dwBuckets.map((item) => ({ value: item, label: dwBucketLabels[item] }))}
          />
        </label>
        <label className="data-filter" htmlFor="dw-dimension">
          <span>분석 차원</span>
          <Select
            id="dw-dimension"
            value={dimension}
            onChange={(event) => onFilterChange({ dimension: event.target.value })}
            options={dwDimensions.map((item) => ({ value: item, label: dwDimensionLabels[item] }))}
          />
        </label>
        <label className="data-filter" htmlFor="dw-order">
          <span>정렬</span>
          <Select
            id="dw-order"
            value={order}
            onChange={(event) => onFilterChange({ order_by: event.target.value })}
            options={dwOrders.map((item) => ({ value: item, label: dwOrderLabels[item] }))}
          />
        </label>
      </Toolbar>

      {selection.kind !== "none" ? (
        <div className="dw-date-selection" role="status">
          <div>
            <p>
              <strong>
                {bounds ? `상세 집계 · ${dwBoundsLabel(bounds)}` : "선택 기간이 올바르지 않습니다."}
              </strong>
            </p>
            <small>
              {bounds
                ? "차원별 집계와 CSV에 적용됩니다. CSV는 같은 조건의 상위 100개 항목을 포함합니다."
                : "시작일과 종료일을 확인하거나 전체 기간으로 돌아가세요."}
            </small>
          </div>
          <Button
            variant="secondary"
            onClick={() => onFilterChange({ since_day: undefined, until_day: undefined })}
          >
            전체 기간으로 돌아가기
          </Button>
        </div>
      ) : null}
      {exportError ? (
        <InlineNotice tone="danger" title="CSV 내보내기 실패">
          {exportError}
        </InlineNotice>
      ) : null}

      <InsightQueryStatus query={overview} label="DW 요약" />

      <StatGrid label="DW 핵심 지표">
        <StatCard label="요청" value={value(summary?.requests, (input) => formatNumber(input))} />
        <StatCard label="토큰" value={value(summary?.tokens, (input) => formatNumber(input))} />
        <StatCard label="누적 비용" value={value(summary?.cost_krw, formatKRW)} />
        <StatCard
          label="오류"
          tone={summary && summary.errors > 0 ? "warning" : "default"}
          value={value(summary?.errors, (input) => formatNumber(input))}
        />
        <StatCard label="오류율" value={value(summary?.error_rate, (input) => formatPercent(input))} />
        <StatCard label="요청당 비용" value={value(summary?.cost_per_request_krw, formatKRW)} />
        <StatCard label="1K 토큰당 비용" value={value(summary?.cost_per_1k_tokens_krw, formatKRW)} />
      </StatGrid>

      {summary && !summary.configured ? (
        <EmptyState
          title="분석 저장소(ClickHouse)가 아직 연결되지 않았습니다."
          description="데이터 파이프라인 탭에서 연결을 테스트하고 스키마를 만들면 이 화면이 채워집니다."
        />
      ) : (
        <>
          <DwTrendPanel
            query={timeseries}
            bucket={bucket}
            range={range}
            selection={selection}
            onSelect={(selected) => onFilterChange({ ...selected })}
          />
          <DwDimensionsPanel
            dimensions={dimensions}
            dimension={dimension}
            order={order}
            periodLabel={bounds ? dwBoundsLabel(bounds) : `${dwWindowLabels[range]} 전체`}
            ready={selectionReady}
          />
          <p className="dw-trend-help">
            아래 분석은 {dwWindowLabels[range]} 전체 기준입니다. 추이에서 선택한 기간은 위 차원별 집계와
            CSV에만 적용됩니다.
          </p>
          <SectionCard title="성능 분석" description="요청 팩트 기반 지연과 스트리밍 비율">
            <InsightQueryStatus query={latency} label="성능 분석" />
            {latency.data?.configured === false ? (
              <InlineNotice tone="info" title="요청 팩트 테이블이 설정되지 않았습니다.">
                clickhouse.request_fact_table 설정을 채우면 지연 분석을 볼 수 있습니다.
              </InlineNotice>
            ) : (
              <>
                <StatGrid label="지연 지표">
                  <StatCard label="P50" value={formatDuration(latency.data?.p50_ms)} />
                  <StatCard label="P95" value={formatDuration(latency.data?.p95_ms)} />
                  <StatCard label="P99" value={formatDuration(latency.data?.p99_ms)} />
                  <StatCard label="첫 청크 P95" value={formatDuration(latency.data?.ttfb_p95_ms)} />
                  <StatCard label="스트리밍 비율" value={formatPercent(latency.data?.stream_share)} />
                  <StatCard label="오류율" value={formatPercent(latency.data?.error_rate)} />
                </StatGrid>
                <SimpleTable<DwLatencyModelRow>
                  caption="모델별 지연과 오류"
                  loading={latency.isPending}
                  rows={latency.data?.by_model ?? []}
                  emptyMessage="집계된 모델이 없습니다."
                  columns={[
                    { id: "model", header: "모델", cell: (row) => row.model || "—" },
                    {
                      id: "requests",
                      header: "요청",
                      cell: (row) => <span className="cell-number">{formatNumber(row.requests)}</span>,
                    },
                    {
                      id: "p95",
                      header: "P95",
                      cell: (row) => <span className="cell-number">{formatDuration(row.p95_ms)}</span>,
                    },
                    {
                      id: "error_rate",
                      header: "오류율",
                      cell: (row) => <span className="cell-number">{formatPercent(row.error_rate)}</span>,
                    },
                  ]}
                />
              </>
            )}
          </SectionCard>

          <SectionCard title="품질 분석" description="자동 평가와 사용자 피드백">
            <InsightQueryStatus query={quality} label="품질 분석" />
            {quality.data && !quality.data.configured ? (
              <InlineNotice tone="info" title="품질 팩트 테이블이 설정되지 않았습니다.">
                clickhouse.eval_fact_table 또는 feedback_fact_table 설정이 필요합니다.
              </InlineNotice>
            ) : (
              <div className="data-panel-grid">
                <div>
                  <StatGrid label="자동 평가">
                    <StatCard label="평가 수" value={formatNumber(evaluation?.total)} />
                    <StatCard label="평균 점수" value={formatNumber(evaluation?.avg_score, 2)} />
                    <StatCard label="통과율" value={formatPercent(evaluation?.pass_rate)} />
                  </StatGrid>
                  <SimpleTable<CountRow>
                    caption="평가 카테고리별 건수"
                    rows={(evaluation?.by_category ?? []).map((row) => ({
                      label: row.category || "—",
                      count: row.count,
                    }))}
                    emptyMessage="평가 결과가 없습니다."
                    columns={countColumns}
                  />
                </div>
                <div>
                  <StatGrid label="사용자 피드백">
                    <StatCard label="피드백 수" value={formatNumber(feedback?.total)} />
                    <StatCard label="긍정 비율" value={formatPercent(feedback?.positive_rate)} />
                    <StatCard label="부정" value={formatNumber(feedback?.negative)} />
                  </StatGrid>
                  <SimpleTable<CountRow>
                    caption="피드백 라벨별 건수"
                    rows={(feedback?.by_label ?? []).map((row) => ({
                      label: row.label || "—",
                      count: row.count,
                    }))}
                    emptyMessage="피드백이 없습니다."
                    columns={countColumns}
                  />
                </div>
              </div>
            )}
          </SectionCard>

          <SectionCard title="라우팅 분석" description="자동 라우팅 결정 근거와 모델 재작성">
            <InsightQueryStatus query={routing} label="라우팅 분석" />
            {routing.data && !routing.data.configured ? (
              <InlineNotice tone="info" title="라우팅 팩트 테이블이 설정되지 않았습니다.">
                clickhouse.routing_fact_table 설정을 채우면 라우팅 분석을 볼 수 있습니다.
              </InlineNotice>
            ) : (
              <>
                <StatGrid label="라우팅 지표">
                  <StatCard label="결정 수" value={formatNumber(routing.data?.total)} />
                  <StatCard label="자동 라우팅 비율" value={formatPercent(routing.data?.auto_route_rate)} />
                  <StatCard label="폴백 발생" value={formatNumber(routing.data?.fallback_used)} />
                  <StatCard label="평균 위험도" value={formatNumber(routing.data?.avg_risk, 2)} />
                </StatGrid>
                <div className="data-panel-grid">
                  <SimpleTable<CountRow>
                    caption="라우팅 결정 근거 Top"
                    rows={(routing.data?.reasons ?? []).map((row) => ({
                      label: row.reason || "—",
                      count: row.count,
                    }))}
                    emptyMessage="결정 근거가 없습니다."
                    columns={countColumns}
                  />
                  <SimpleTable<CountRow>
                    caption="모델 재작성 Top"
                    rows={(routing.data?.rewrites ?? []).map((row) => ({
                      label: `${row.from || "—"} → ${row.to || "—"}`,
                      count: row.count,
                    }))}
                    emptyMessage="재작성 사례가 없습니다."
                    columns={countColumns}
                  />
                </div>
              </>
            )}
          </SectionCard>

          <SectionCard title="Text2SQL 분석" description="질의 검증, 실행, 차단 현황">
            <InsightQueryStatus query={text2sql} label="Text2SQL 분석" />
            {text2sql.data && !text2sql.data.configured ? (
              <InlineNotice tone="info" title="Text2SQL 팩트 테이블이 설정되지 않았습니다.">
                clickhouse.text2sql_fact_table 설정을 채우면 Text2SQL 분석을 볼 수 있습니다.
              </InlineNotice>
            ) : (
              <>
                <StatGrid label="Text2SQL 지표">
                  <StatCard label="질의 수" value={formatNumber(text2sql.data?.total)} />
                  <StatCard label="실행" value={formatNumber(text2sql.data?.executed)} />
                  <StatCard label="차단율" value={formatPercent(text2sql.data?.block_rate)} />
                  <StatCard label="평균 위험도" value={formatNumber(text2sql.data?.avg_explain_risk, 2)} />
                </StatGrid>
                <SimpleTable<CountRow>
                  caption="Text2SQL 실패 사유"
                  rows={(text2sql.data?.failures ?? []).map((row) => ({
                    label: row.reason || "—",
                    count: row.count,
                  }))}
                  emptyMessage="실패 사유가 없습니다."
                  columns={countColumns}
                />
              </>
            )}
          </SectionCard>

          <DwSavingsPanel savings={savings} modelMigration={modelMigration} dimension={dimension} />
        </>
      )}
    </div>
  );
}
