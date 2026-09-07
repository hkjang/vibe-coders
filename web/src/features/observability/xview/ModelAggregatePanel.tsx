import { useQuery } from "@tanstack/react-query";

import { TimeSeriesChart, type ChartSeries } from "@/features/observability/charts";
import type { XViewFilters } from "@/features/observability/xview/use-xview-live";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime, formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";

interface ModelAggregatePanelProps {
  filters: XViewFilters;
}

interface Coverage {
  truncated: boolean;
  sample_size: number;
  aggregate_limit: number;
  covered_since: string;
}

/**
 * The aggregate endpoints answer from a bounded sample. When the sample was cut
 * short the numbers describe only part of the window, so the disclosure is shown
 * with the figures rather than hidden behind a tooltip.
 */
function CoverageNotice({ coverage, label }: { coverage: Coverage; label: string }): React.JSX.Element {
  if (!coverage.truncated) {
    return (
      <p className="obs-coverage obs-meta" role="status">
        {label}: 표본 {formatNumber(coverage.sample_size)}건 (상한 {formatNumber(coverage.aggregate_limit)}건)
        · 조회 구간 전체를 집계했습니다.
      </p>
    );
  }
  return (
    <InlineNotice tone="warning" title={`${label}: 표본이 잘렸습니다.`}>
      상한 {formatNumber(coverage.aggregate_limit)}건에 걸려 최근 {formatNumber(coverage.sample_size)}건만
      집계했습니다.
      {coverage.covered_since
        ? ` ${formatDateTime(coverage.covered_since)} 이전 트래픽은 이 수치에 포함되지 않습니다.`
        : " 조회 구간의 앞부분은 이 수치에 포함되지 않습니다."}{" "}
      구간을 좁히거나 모델 필터를 걸어 다시 확인하세요.
    </InlineNotice>
  );
}

export function ModelAggregatePanel({ filters }: ModelAggregatePanelProps): React.JSX.Element {
  const models = useQuery({
    queryKey: ["observability", "xview", "models", filters],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.observability.xview.models, {
        query: { ...filters, top: 10 },
        signal,
        routeId: "observability.xview.models",
      }),
    staleTime: 30_000,
  });
  const series = useQuery({
    queryKey: ["observability", "xview", "model-series", filters],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.observability.xview.modelSeries, {
        query: { ...filters, bucket: "hour" },
        signal,
        routeId: "observability.xview.model-series",
      }),
    staleTime: 30_000,
  });
  const outliers = useQuery({
    queryKey: ["observability", "xview", "model-outliers", filters],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.observability.xview.modelOutliers, {
        query: filters,
        signal,
        routeId: "observability.xview.model-outliers",
      }),
    staleTime: 30_000,
  });

  const groups = models.data?.models ?? [];
  const seriesEntries = Object.entries(series.data?.series ?? {})
    .sort((left, right) => right[1].length - left[1].length)
    .slice(0, 3);
  const colorVars = ["--obs-series-1", "--obs-series-2", "--obs-series-3"] as const;
  const labels = [...new Set(seriesEntries.flatMap(([, points]) => points.map((point) => point.ts)))].sort();
  const chartSeries: ReadonlyArray<ChartSeries> = seriesEntries.map(([model, points], index) => ({
    id: model,
    name: model || "(미상)",
    colorVar: colorVars[index] ?? "--obs-series-other",
    points: labels.map((label) => ({
      label,
      value: points.find((point) => point.ts === label)?.count ?? 0,
    })),
  }));

  return (
    <div className="obs-section-stack">
      <SectionCard
        title="모델별 요약"
        description="선택한 구간의 모델별 호출량, 지연 분포와 비용입니다."
        actions={
          <Button size="small" onClick={() => void models.refetch()} disabled={models.isFetching}>
            새로고침
          </Button>
        }
      >
        {models.isError ? (
          <InlineNotice tone="danger" title="모델 집계를 불러오지 못했습니다.">
            {safeAppErrorMessage(models.error, "모델 집계를 불러오지 못했습니다.")}
            {isAppError(models.error) && models.error.requestId ? (
              <span className="request-id"> 요청 ID: {models.error.requestId}</span>
            ) : null}
          </InlineNotice>
        ) : null}
        {models.data ? <CoverageNotice coverage={models.data} label="모델별 요약" /> : null}
        {!models.isPending && groups.length === 0 ? (
          <EmptyState
            title="집계할 호출이 없습니다."
            description="조회 구간을 넓히거나 모델 필터를 비워 다시 조회하세요."
          />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="모델별 요약 표 영역">
            <table className="data-table">
              <caption className="sr-only">모델별 호출 집계</caption>
              <thead>
                <tr>
                  <th scope="col">모델</th>
                  <th scope="col">호출</th>
                  <th scope="col">오류율</th>
                  <th scope="col">P50</th>
                  <th scope="col">P95</th>
                  <th scope="col">P99</th>
                  <th scope="col">첫 청크 평균</th>
                  <th scope="col">토큰</th>
                  <th scope="col">비용</th>
                  <th scope="col">폴백</th>
                  <th scope="col">정책 신호</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.model}>
                    <th scope="row">{group.model || "(미상)"}</th>
                    <td className="cell-number">{formatNumber(group.count)}</td>
                    <td className="cell-number">{formatPercent(group.error_rate)}</td>
                    <td className="cell-number">{formatNumber(group.p50)}ms</td>
                    <td className="cell-number">{formatNumber(group.p95)}ms</td>
                    <td className="cell-number">{formatNumber(group.p99)}ms</td>
                    <td className="cell-number">{formatNumber(group.avg_first_chunk_ms)}ms</td>
                    <td className="cell-number">{formatNumber(group.total_tokens)}</td>
                    <td className="cell-number">{formatKRW(group.total_cost_krw)}</td>
                    <td className="cell-number">{formatNumber(group.failover_count)}</td>
                    <td className="cell-number">{formatNumber(group.governance_count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard title="모델별 호출 추이" description="상위 3개 모델의 구간별 호출 수입니다.">
        {series.isError ? (
          <InlineNotice tone="danger" title="추이를 불러오지 못했습니다.">
            {safeAppErrorMessage(series.error, "추이를 불러오지 못했습니다.")}
          </InlineNotice>
        ) : null}
        {series.data ? <CoverageNotice coverage={series.data} label="모델별 추이" /> : null}
        {chartSeries.length === 0 ? (
          <EmptyState title="표시할 추이가 없습니다." description="조회 구간에 호출이 없습니다." />
        ) : (
          <TimeSeriesChart
            caption="상위 모델의 구간별 호출 수"
            series={chartSeries}
            format={(value) => formatNumber(value)}
            valueLabel="호출"
          />
        )}
      </SectionCard>

      <SectionCard
        title="이상치 요청"
        description="모델 P95를 넘겼거나 오류·폴백·정책 신호가 붙은 요청입니다."
      >
        {outliers.isError ? (
          <InlineNotice tone="danger" title="이상치를 불러오지 못했습니다.">
            {safeAppErrorMessage(outliers.error, "이상치를 불러오지 못했습니다.")}
          </InlineNotice>
        ) : null}
        {outliers.data ? <CoverageNotice coverage={outliers.data} label="이상치" /> : null}
        {(outliers.data?.outliers ?? []).length === 0 && !outliers.isPending ? (
          <EmptyState title="이상치가 없습니다." description="선택한 구간에서 눈에 띄는 요청이 없습니다." />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="이상치 요청 표 영역">
            <table className="data-table">
              <caption className="sr-only">이상치로 표시된 요청</caption>
              <thead>
                <tr>
                  <th scope="col">요청 ID</th>
                  <th scope="col">모델</th>
                  <th scope="col">지연</th>
                  <th scope="col">표시</th>
                </tr>
              </thead>
              <tbody>
                {(outliers.data?.outliers ?? []).slice(0, 100).map((outlier, index) => (
                  <tr key={`${outlier.request_id}-${index}`}>
                    <th scope="row" className="mono truncate">
                      {outlier.request_id}
                    </th>
                    <td>{outlier.model || "(미상)"}</td>
                    <td className="cell-number">{formatNumber(outlier.latency_ms)}ms</td>
                    <td>
                      <div className="obs-timeline-badges">
                        {outlier.tags.map((tag) => (
                          <Badge
                            key={tag}
                            tone={
                              tag === "error_5xx" || tag === "error_4xx"
                                ? "danger"
                                : tag === "failover"
                                  ? "warning"
                                  : tag === "governance"
                                    ? "info"
                                    : "muted"
                            }
                          >
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
