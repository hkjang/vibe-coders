import { Download, RefreshCw } from "lucide-react";
import { useState } from "react";

import { DataQueryNotice } from "@/features/data/DataQueryNotice";
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
import type {
  DwDimensionRow,
  DwLatencyModelRow,
  DwTimeseriesPoint,
  ModelMigrationRecommendation,
  SavingsScope,
} from "@/shared/api/domains/data.schemas";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDuration, formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";

interface InsightsTabProps {
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
  bucket,
  dimension,
  onFilterChange,
  order,
  range,
}: InsightsTabProps): React.JSX.Element {
  const { overview, timeseries, dimensions, latency, quality, routing, text2sql, savings, modelMigration } =
    useInsightsQueries(range, bucket, dimension, order);
  const [exportError, setExportError] = useState<string | undefined>();
  const [exporting, setExporting] = useState(false);

  const exportCsv = (): void => {
    setExporting(true);
    setExportError(undefined);
    void downloadDwDashboardCsv(range, dimension, order)
      .catch((cause: unknown) => {
        setExportError(safeAppErrorMessage(cause, "CSV를 내보내지 못했습니다."));
      })
      .finally(() => setExporting(false));
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
          <Button variant="secondary" onClick={exportCsv} disabled={exporting || !summary?.configured}>
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

      {exportError ? (
        <InlineNotice tone="danger" title="CSV 내보내기 실패">
          {exportError}
        </InlineNotice>
      ) : null}

      {overview.isError ? (
        <DataQueryNotice
          error={overview.error}
          hasPreviousData={Boolean(summary)}
          label="DW 요약"
          onRetry={() => void overview.refetch()}
        />
      ) : null}

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
          <SectionCard
            title="비용 추이"
            description={`집계 기준 ${dwBucketLabels[bucket]} · ${dwWindowLabels[range]}`}
          >
            {timeseries.isError ? (
              <DataQueryNotice
                error={timeseries.error}
                hasPreviousData={Boolean(timeseries.data)}
                label="비용 추이"
                onRetry={() => void timeseries.refetch()}
              />
            ) : null}
            <SimpleTable<DwTimeseriesPoint>
              caption="일자별 요청, 토큰, 비용, 오류"
              loading={timeseries.isPending}
              rows={timeseries.data?.points ?? []}
              emptyMessage="선택한 구간에 집계된 데이터가 없습니다."
              columns={[
                { id: "day", header: "기간", cell: (row) => row.day },
                {
                  id: "requests",
                  header: "요청",
                  cell: (row) => <span className="cell-number">{formatNumber(row.requests)}</span>,
                },
                {
                  id: "tokens",
                  header: "토큰",
                  cell: (row) => <span className="cell-number">{formatNumber(row.tokens)}</span>,
                },
                {
                  id: "cost",
                  header: "비용",
                  cell: (row) => <span className="cell-number">{formatKRW(row.cost_krw)}</span>,
                },
                {
                  id: "errors",
                  header: "오류",
                  cell: (row) => <span className="cell-number">{formatNumber(row.errors)}</span>,
                },
              ]}
            />
          </SectionCard>

          <SectionCard
            title={`${dwDimensionLabels[dimension]}별 Top 10`}
            description={`${dwOrderLabels[order]} 정렬`}
          >
            {dimensions.isError ? (
              <DataQueryNotice
                error={dimensions.error}
                hasPreviousData={Boolean(dimensions.data)}
                label="차원별 집계"
                onRetry={() => void dimensions.refetch()}
              />
            ) : null}
            <SimpleTable<DwDimensionRow>
              caption={`${dwDimensionLabels[dimension]}별 사용량과 비용`}
              loading={dimensions.isPending}
              rows={dimensions.data?.rows ?? []}
              emptyMessage="집계된 항목이 없습니다."
              columns={[
                { id: "value", header: dwDimensionLabels[dimension], cell: (row) => row.value || "—" },
                {
                  id: "requests",
                  header: "요청",
                  cell: (row) => <span className="cell-number">{formatNumber(row.requests)}</span>,
                },
                {
                  id: "tokens",
                  header: "토큰",
                  cell: (row) => <span className="cell-number">{formatNumber(row.tokens)}</span>,
                },
                {
                  id: "cost",
                  header: "비용",
                  cell: (row) => <span className="cell-number">{formatKRW(row.cost_krw)}</span>,
                },
                {
                  id: "error_rate",
                  header: "오류율",
                  cell: (row) => <span className="cell-number">{formatPercent(row.error_rate)}</span>,
                },
              ]}
            />
          </SectionCard>

          <SectionCard title="성능 분석" description="요청 팩트 기반 지연과 스트리밍 비율">
            {latency.isError ? (
              <DataQueryNotice
                error={latency.error}
                hasPreviousData={Boolean(latency.data)}
                label="성능 분석"
                onRetry={() => void latency.refetch()}
              />
            ) : null}
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
            {quality.isError ? (
              <DataQueryNotice
                error={quality.error}
                hasPreviousData={Boolean(quality.data)}
                label="품질 분석"
                onRetry={() => void quality.refetch()}
              />
            ) : null}
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
            {routing.isError ? (
              <DataQueryNotice
                error={routing.error}
                hasPreviousData={Boolean(routing.data)}
                label="라우팅 분석"
                onRetry={() => void routing.refetch()}
              />
            ) : null}
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
            {text2sql.isError ? (
              <DataQueryNotice
                error={text2sql.error}
                hasPreviousData={Boolean(text2sql.data)}
                label="Text2SQL 분석"
                onRetry={() => void text2sql.refetch()}
              />
            ) : null}
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

          <SectionCard
            title="비용 절감·모델 전환"
            description="다운시프트와 캐시로 아낀 금액, 그리고 지금 바꿀 만한 모델 후보입니다. 운영 데이터베이스에서 실시간으로 계산합니다."
          >
            {savings.isError ? (
              <DataQueryNotice
                error={savings.error}
                hasPreviousData={Boolean(savings.data)}
                label="비용 절감"
                onRetry={() => void savings.refetch()}
              />
            ) : null}
            {modelMigration.isError ? (
              <DataQueryNotice
                error={modelMigration.error}
                hasPreviousData={Boolean(modelMigration.data)}
                label="모델 전환 추천"
                onRetry={() => void modelMigration.refetch()}
              />
            ) : null}
            <StatGrid label="절감 지표">
              <StatCard
                label="총 절감액"
                value={formatKRW(savings.data?.total_savings_krw)}
                hint="다운시프트 + 캐시"
              />
              <StatCard
                label="다운시프트 절감"
                value={formatKRW(savings.data?.total_downshift_savings_krw)}
              />
              <StatCard
                label="캐시 절감"
                value={formatKRW(savings.data?.total_cache_savings_krw)}
                hint={savings.data?.cache_savings_estimated ? "추정치" : undefined}
              />
              <StatCard
                label="전환 예상 절감"
                value={formatKRW(modelMigration.data?.total_estimated_savings_krw)}
                hint={`추천 ${formatNumber(modelMigration.data?.count ?? 0)}건`}
              />
            </StatGrid>
            <SimpleTable<SavingsScope>
              caption={`${dwDimensionLabels[dimension]}별 절감액`}
              loading={savings.isPending}
              rows={savings.data?.scopes ?? []}
              emptyMessage="집계된 절감액이 없습니다."
              columns={[
                { id: "scope", header: dwDimensionLabels[dimension], cell: (row) => row.scope || "—" },
                {
                  id: "downshift",
                  header: "다운시프트",
                  cell: (row) => <span className="cell-number">{formatNumber(row.downshift_requests)}</span>,
                },
                {
                  id: "downshift_krw",
                  header: "다운시프트 절감",
                  cell: (row) => <span className="cell-number">{formatKRW(row.downshift_savings_krw)}</span>,
                },
                {
                  id: "cache",
                  header: "캐시 적중",
                  cell: (row) => <span className="cell-number">{formatNumber(row.cache_hits)}</span>,
                },
                {
                  id: "total",
                  header: "합계",
                  cell: (row) => <span className="cell-number">{formatKRW(row.total_savings_krw)}</span>,
                },
              ]}
            />
            <SimpleTable<ModelMigrationRecommendation>
              caption="모델 전환 추천"
              loading={modelMigration.isPending}
              rows={modelMigration.data?.recommendations ?? []}
              emptyMessage="전환을 추천할 만한 작업 유형이 없습니다."
              columns={[
                { id: "task", header: "작업 유형", cell: (row) => row.task_type || "—" },
                {
                  id: "requests",
                  header: "요청",
                  cell: (row) => <span className="cell-number">{formatNumber(row.requests)}</span>,
                },
                { id: "current", header: "현재 모델", cell: (row) => row.current_model || "—" },
                { id: "recommended", header: "추천 모델", cell: (row) => row.recommended_model || "—" },
                {
                  id: "success",
                  header: "성공률",
                  cell: (row) =>
                    `${formatPercent(row.current_success_rate)} → ${formatPercent(row.recommended_success_rate)}`,
                },
                {
                  id: "savings",
                  header: "예상 절감",
                  cell: (row) => <span className="cell-number">{formatKRW(row.estimated_savings_krw)}</span>,
                },
              ]}
            />
          </SectionCard>
        </>
      )}

      <p className="data-updated-at" role="status">
        {overview.isFetching ? (
          <>
            <RefreshCw aria-hidden="true" /> 갱신 중입니다.
          </>
        ) : (
          `마지막 갱신: ${overview.dataUpdatedAt ? new Date(overview.dataUpdatedAt).toLocaleString("ko-KR") : "—"}`
        )}
      </p>
    </div>
  );
}
