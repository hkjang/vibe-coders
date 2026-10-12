import type { UseQueryResult } from "@tanstack/react-query";
import { CircleDollarSign, DatabaseZap, Gauge, LockKeyhole, Route, ShieldAlert } from "lucide-react";
import { healthStatusLabels, riskLevelLabels } from "@/config/ui-labels";
import {
  formatBytes,
  formatInteger,
  formatKRW,
  formatMilliseconds,
  formatPercent,
  healthRangeLabels,
  type HealthRange,
} from "@/features/health/health-utils";
import { HealthWidget } from "@/features/health/health-ui";
import type { AdminStats, OpsRiskResponse, RoutingHealth } from "@/shared/api/schemas";

type WidgetQuery<Data> = Pick<
  UseQueryResult<Data>,
  "data" | "error" | "isPending" | "isError" | "dataUpdatedAt" | "refetch"
>;

interface OverviewStatusTabProps {
  stats: WidgetQuery<AdminStats>;
  routing: WidgetQuery<RoutingHealth>;
  operations: WidgetQuery<OpsRiskResponse>;
  range: HealthRange;
  canReadRouting: boolean;
  routingNeedsAttention: boolean;
  operationsNeedAttention: boolean;
}

function ratio(part: number, total: number): number {
  return total > 0 ? part / total : 0;
}

export function OverviewStatusTab({
  stats,
  routing,
  operations,
  range,
  canReadRouting,
  routingNeedsAttention,
  operationsNeedAttention,
}: OverviewStatusTabProps): React.JSX.Element {
  const opsStatus = operations.data?.status;
  const opsRisk = operations.data?.risk;
  const fallbackUnavailable =
    opsStatus?.partial_failures?.some((failure) => failure.component === "fallback") ?? false;
  return (
    <section className="health-grid" aria-label="운영 영역 요약">
      <HealthWidget
        title="보존 트래픽과 비용"
        description="저장된 요청 로그의 전체 보존 기간 집계"
        icon={CircleDollarSign}
        loading={stats.isPending}
        error={stats.error}
        onRetry={() => void stats.refetch()}
        updatedAt={stats.dataUpdatedAt || undefined}
        status={stats.isError ? "갱신 실패" : stats.data ? "보존 데이터" : undefined}
        statusTone={stats.isError ? "warning" : "muted"}
      >
        {stats.data ? (
          <>
            <div className="metric-value">
              <strong>{formatKRW(stats.data.total_cost_krw)}</strong>
              <span>누적 비용</span>
            </div>
            <dl className="metric-pairs">
              <div>
                <dt>성공률</dt>
                <dd>
                  {formatPercent(
                    ratio(
                      stats.data.by_status.find((item) => item.class === "2xx")?.requests ?? 0,
                      stats.data.total_requests,
                    ),
                  )}
                </dd>
              </div>
              <div>
                <dt>전체 요청</dt>
                <dd>{formatInteger(stats.data.total_requests)}</dd>
              </div>
              <div>
                <dt>평균 지연</dt>
                <dd>{formatMilliseconds(stats.data.average_latency_ms)}</dd>
              </div>
              <div>
                <dt>전체 토큰</dt>
                <dd>{formatInteger(stats.data.total_tokens)}</dd>
              </div>
            </dl>
          </>
        ) : null}
      </HealthWidget>

      {stats.isPending || stats.data ? (
        <HealthWidget
          title="프로세스 런타임"
          description="현재 게이트웨이 프로세스 시작 이후 로컬 지표"
          icon={Gauge}
          loading={stats.isPending}
          error={stats.error}
          onRetry={() => void stats.refetch()}
          updatedAt={stats.dataUpdatedAt || undefined}
          status={stats.isError ? "갱신 실패" : stats.data ? "재시작 후" : undefined}
          statusTone={stats.isError ? "warning" : "muted"}
        >
          {stats.data ? (
            <>
              <div className="metric-value">
                <strong>{formatMilliseconds(stats.data.latency_quantiles.p95)}</strong>
                <span>P95 지연</span>
              </div>
              <dl className="metric-pairs">
                <div>
                  <dt>캐시 적중률</dt>
                  <dd>
                    {formatPercent(
                      ratio(stats.data.cache_hits, stats.data.cache_hits + stats.data.cache_misses),
                    )}
                  </dd>
                </div>
                <div>
                  <dt>장애 전환</dt>
                  <dd>{formatInteger(stats.data.failover_total)}</dd>
                </div>
                <div>
                  <dt>첫 응답 P95</dt>
                  <dd>{formatMilliseconds(stats.data.first_chunk_quantiles.p95)}</dd>
                </div>
              </dl>
            </>
          ) : null}
        </HealthWidget>
      ) : null}

      <HealthWidget
        title="라우팅"
        description={`${healthRangeLabels[range]} 선택 기간의 공급자와 회로 차단기`}
        icon={Route}
        loading={canReadRouting && routing.isPending}
        error={canReadRouting ? routing.error : undefined}
        onRetry={canReadRouting ? () => void routing.refetch() : undefined}
        updatedAt={canReadRouting ? routing.dataUpdatedAt || undefined : undefined}
        status={
          canReadRouting
            ? routing.isError
              ? "갱신 실패"
              : routing.data
                ? routingNeedsAttention
                  ? healthStatusLabels.degraded
                  : healthStatusLabels.healthy
                : undefined
            : "권한 필요"
        }
        statusTone={
          canReadRouting ? (routing.isError || routingNeedsAttention ? "warning" : "success") : "muted"
        }
      >
        {!canReadRouting ? (
          <div className="health-empty health-permission" role="status">
            <LockKeyhole aria-hidden="true" />
            <strong>라우팅 신호는 제한되어 있습니다.</strong>
            <span>관리자에게 routing:read 권한을 요청하세요.</span>
          </div>
        ) : routing.data ? (
          <dl className="metric-pairs">
            <div>
              <dt>공급자</dt>
              <dd>{formatInteger(routing.data.providers.length)}</dd>
            </div>
            <div>
              <dt>저하 공급자</dt>
              <dd>{formatInteger(routing.data.degraded.length)}</dd>
            </div>
            <div>
              <dt>경고</dt>
              <dd>{formatInteger(routing.data.alerts.length)}</dd>
            </div>
            <div>
              <dt>열린 회로 차단기</dt>
              <dd>
                {formatInteger(routing.data.breakers.states.filter((state) => state.phase === "open").length)}
              </dd>
            </div>
          </dl>
        ) : null}
      </HealthWidget>

      <HealthWidget
        title="운영 위험"
        description="현재 설정과 운영 신호를 기준으로 산출한 위험도"
        icon={ShieldAlert}
        loading={operations.isPending}
        error={operations.error}
        onRetry={() => void operations.refetch()}
        updatedAt={operations.dataUpdatedAt || undefined}
        status={operations.isError ? "갱신 실패" : opsRisk ? riskLevelLabels[opsRisk.tier] : undefined}
        statusTone={
          operations.isError
            ? "warning"
            : opsRisk?.tier === "critical" || opsRisk?.tier === "high"
              ? "danger"
              : opsRisk?.tier === "medium"
                ? "warning"
                : "success"
        }
      >
        {opsRisk ? (
          <>
            <div className="metric-value">
              <strong>{opsRisk.score}</strong>
              <span>/ 100 위험 점수</span>
            </div>
            <p className="metric-note">
              {opsRisk.factors.length
                ? `확인이 필요한 요인 ${formatInteger(opsRisk.factors.length)}개`
                : "현재 탐지된 위험 요인이 없습니다."}
            </p>
          </>
        ) : null}
      </HealthWidget>

      {operations.isPending || operations.data ? (
        <HealthWidget
          title="운영 기반"
          description="로깅, 대체 응답 파일과 저장 공간의 현재 현황"
          icon={DatabaseZap}
          loading={operations.isPending}
          error={operations.error}
          onRetry={() => void operations.refetch()}
          updatedAt={operations.dataUpdatedAt || undefined}
          status={
            operations.isError
              ? "갱신 실패"
              : opsStatus
                ? operationsNeedAttention
                  ? healthStatusLabels.attention
                  : healthStatusLabels.normal
                : undefined
          }
          statusTone={operations.isError || operationsNeedAttention ? "warning" : "success"}
        >
          {opsStatus ? (
            <dl className="metric-pairs">
              <div>
                <dt>로그 대기열</dt>
                <dd>{formatInteger(opsStatus.logging.queue_depth)}</dd>
              </div>
              <div>
                <dt>누락 로그</dt>
                <dd>{formatInteger(opsStatus.logging.dropped)}</dd>
              </div>
              <div>
                <dt>대체 응답 파일 크기</dt>
                <dd>{fallbackUnavailable ? "확인 실패" : formatBytes(opsStatus.fallback.bytes)}</dd>
              </div>
              <div>
                <dt>디스크 사용</dt>
                <dd>
                  {opsStatus.disk.available ? formatPercent(opsStatus.disk.used_percent / 100) : "확인 실패"}
                </dd>
              </div>
            </dl>
          ) : null}
        </HealthWidget>
      ) : null}
    </section>
  );
}
