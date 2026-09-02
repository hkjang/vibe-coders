import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  CircleDollarSign,
  DatabaseZap,
  Gauge,
  LockKeyhole,
  RefreshCw,
  Route,
  ShieldAlert,
} from "lucide-react";

import { useAuth } from "@/app/auth/AuthProvider";
import {
  formatBytes,
  formatInteger,
  formatKRW,
  formatMilliseconds,
  formatPercent,
  maxUpdatedAt,
  refreshIntervalMs,
} from "@/features/health/health-utils";
import { HealthWidget, TimeRangePicker, UpdatedTime } from "@/features/health/health-ui";
import { useHealthRange } from "@/features/health/use-health-range";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { usePreferences } from "@/shared/stores/preferences";

function ratio(part: number, total: number): number {
  return total > 0 ? part / total : 0;
}

export function OverviewPage(): React.JSX.Element {
  const refreshInterval = usePreferences((state) => state.refreshInterval);
  const interval = refreshIntervalMs(refreshInterval);
  const auth = useAuth();
  const [range, setRange] = useHealthRange();
  const showLegacyAdmin = canOpenLegacyAdmin(auth);
  const canReadRouting =
    auth.mode === "open" || auth.mode === "legacy" || Boolean(auth.user?.scopes.includes("routing:read"));

  const health = useQuery({
    queryKey: ["gateway", "health"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.health, {
        signal,
        routeId: "overview.health",
      }),
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
  const stats = useQuery({
    queryKey: ["admin", "stats"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.admin.stats, {
        signal,
        routeId: "overview.traffic",
      }),
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
  const routing = useQuery({
    queryKey: ["admin", "routing", "health", range],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.admin.routing.health, {
        query: { window: range, threshold: 70 },
        signal,
        routeId: "overview.routing",
      }),
    enabled: canReadRouting,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
  const operations = useQuery({
    queryKey: ["admin", "ops", "risk"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.admin.ops.risk, {
        signal,
        routeId: "overview.operations",
      }),
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });

  const routingNeedsAttention =
    canReadRouting &&
    (Boolean(routing.data?.degraded.length) ||
      Boolean(routing.data?.alerts.some((alert) => alert.severity !== "info")) ||
      Boolean(routing.data?.breakers.states.some((state) => state.phase !== "closed")));
  const opsStatus = operations.data?.status;
  const opsRisk = operations.data?.risk;
  const fallbackUnavailable =
    opsStatus?.partial_failures?.some((failure) => failure.component === "fallback") ?? false;
  const operationsNeedAttention =
    Boolean(opsRisk?.factors.length) ||
    Boolean(opsStatus?.partial_failures?.length) ||
    Boolean(opsStatus?.logging.dropped) ||
    opsStatus?.disk.available === false;
  const secondaryFailure = stats.isError || (canReadRouting && routing.isError) || operations.isError;
  const checking =
    health.isPending || stats.isPending || (canReadRouting && routing.isPending) || operations.isPending;
  const degraded =
    health.isError ||
    secondaryFailure ||
    routingNeedsAttention ||
    operationsNeedAttention ||
    (opsRisk?.tier !== undefined && opsRisk.tier !== "low");
  const overallStatus =
    health.isError && !health.data
      ? "Disconnected"
      : checking
        ? "Checking"
        : health.data?.status === "ok"
          ? degraded
            ? "Degraded"
            : "Healthy"
          : "Checking";
  const overallTone =
    overallStatus === "Healthy"
      ? "success"
      : overallStatus === "Checking"
        ? "muted"
        : overallStatus === "Degraded"
          ? "warning"
          : "danger";
  const updatedAt = maxUpdatedAt(
    health.dataUpdatedAt,
    stats.dataUpdatedAt,
    canReadRouting ? routing.dataUpdatedAt : 0,
    operations.dataUpdatedAt,
  );
  const refreshing =
    health.isFetching || stats.isFetching || (canReadRouting && routing.isFetching) || operations.isFetching;

  const refreshAll = (): void => {
    void Promise.all([
      health.refetch(),
      stats.refetch(),
      operations.refetch(),
      ...(canReadRouting ? [routing.refetch()] : []),
    ]);
  };

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <div className="eyebrow">Preview Read Only</div>
          <h1>운영 Overview</h1>
          <p>Gateway 상태, 트래픽, 비용과 위험 신호를 한 화면에서 확인합니다.</p>
        </div>
        <div className="page-actions">
          <Badge tone={overallTone}>{overallStatus}</Badge>
          {showLegacyAdmin ? (
            <a className="button button-secondary button-default" href="/admin#/dashboard">
              Legacy에서 열기
            </a>
          ) : null}
          <Button onClick={refreshAll} disabled={refreshing}>
            <RefreshCw aria-hidden="true" /> 전체 새로고침
          </Button>
        </div>
      </header>

      <div className="health-page-toolbar">
        <TimeRangePicker value={range} onChange={setRange} />
        <div className="status-meta">
          <span>Backend {auth.backendVersion}</span>
          {updatedAt > 0 ? <UpdatedTime timestamp={updatedAt} /> : null}
        </div>
      </div>

      <section className="status-banner" aria-labelledby="gateway-health-title">
        <div className="status-icon" data-status={overallStatus.toLowerCase()}>
          <Activity aria-hidden="true" />
        </div>
        <div>
          <h2 id="gateway-health-title">Gateway Health</h2>
          {health.isPending ? <p>Gateway 연결을 확인하는 중입니다.</p> : null}
          {health.data ? (
            <p>
              Gateway는 요청을 처리할 수 있으며, 운영 신호는 <strong>{overallStatus}</strong> 상태입니다.
            </p>
          ) : null}
          {health.isError ? (
            <p>
              {health.data
                ? "새 상태 갱신에 실패해 마지막 정상 응답을 표시합니다."
                : "Gateway 상태 확인에 실패했습니다. 각 영역의 재시도를 이용하세요."}
            </p>
          ) : null}
        </div>
        <Badge tone={overallTone}>{overallStatus}</Badge>
      </section>

      <section className="health-grid" aria-label="운영 영역 요약">
        <HealthWidget
          title="보존 트래픽과 비용"
          description="저장된 요청 로그의 전체 보존 기간 집계"
          icon={CircleDollarSign}
          loading={stats.isPending}
          error={stats.error}
          onRetry={() => void stats.refetch()}
          updatedAt={stats.dataUpdatedAt || undefined}
          status={stats.data ? "보존 데이터" : undefined}
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
                  <dt>전체 Token</dt>
                  <dd>{formatInteger(stats.data.total_tokens)}</dd>
                </div>
              </dl>
            </>
          ) : null}
        </HealthWidget>

        {stats.isPending || stats.data ? (
          <HealthWidget
            title="프로세스 런타임"
            description="현재 Gateway 프로세스 시작 이후 로컬 지표"
            icon={Gauge}
            loading={stats.isPending}
            updatedAt={stats.dataUpdatedAt || undefined}
            status={stats.data ? "재시작 후" : undefined}
          >
            {stats.data ? (
              <>
                <div className="metric-value">
                  <strong>{formatMilliseconds(stats.data.latency_quantiles.p95)}</strong>
                  <span>P95 지연</span>
                </div>
                <dl className="metric-pairs">
                  <div>
                    <dt>Cache hit</dt>
                    <dd>
                      {formatPercent(
                        ratio(stats.data.cache_hits, stats.data.cache_hits + stats.data.cache_misses),
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Failover</dt>
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
          description={`${range} 선택 기간의 Provider와 Circuit Breaker`}
          icon={Route}
          loading={canReadRouting && routing.isPending}
          error={canReadRouting ? routing.error : undefined}
          onRetry={canReadRouting ? () => void routing.refetch() : undefined}
          updatedAt={canReadRouting ? routing.dataUpdatedAt || undefined : undefined}
          status={
            canReadRouting
              ? routing.data
                ? routingNeedsAttention
                  ? "Degraded"
                  : "Healthy"
                : undefined
              : "권한 필요"
          }
          statusTone={canReadRouting ? (routingNeedsAttention ? "warning" : "success") : "muted"}
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
                <dt>Provider</dt>
                <dd>{formatInteger(routing.data.providers.length)}</dd>
              </div>
              <div>
                <dt>저하 Provider</dt>
                <dd>{formatInteger(routing.data.degraded.length)}</dd>
              </div>
              <div>
                <dt>경고</dt>
                <dd>{formatInteger(routing.data.alerts.length)}</dd>
              </div>
              <div>
                <dt>Open Breaker</dt>
                <dd>
                  {formatInteger(
                    routing.data.breakers.states.filter((state) => state.phase === "open").length,
                  )}
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
          status={opsRisk?.tier.toUpperCase()}
          statusTone={
            opsRisk?.tier === "critical" || opsRisk?.tier === "high"
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
                <span>/ 100 risk score</span>
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
            description="로깅, fallback 파일과 저장 공간의 현재 snapshot"
            icon={DatabaseZap}
            loading={operations.isPending}
            updatedAt={operations.dataUpdatedAt || undefined}
            status={opsStatus ? (operationsNeedAttention ? "Attention" : "Normal") : undefined}
            statusTone={operationsNeedAttention ? "warning" : "success"}
          >
            {opsStatus ? (
              <dl className="metric-pairs">
                <div>
                  <dt>로그 Queue</dt>
                  <dd>{formatInteger(opsStatus.logging.queue_depth)}</dd>
                </div>
                <div>
                  <dt>누락 로그</dt>
                  <dd>{formatInteger(opsStatus.logging.dropped)}</dd>
                </div>
                <div>
                  <dt>Fallback 크기</dt>
                  <dd>{fallbackUnavailable ? "확인 실패" : formatBytes(opsStatus.fallback.bytes)}</dd>
                </div>
                <div>
                  <dt>디스크 사용</dt>
                  <dd>
                    {opsStatus.disk.available
                      ? formatPercent(opsStatus.disk.used_percent / 100)
                      : "확인 실패"}
                  </dd>
                </div>
              </dl>
            ) : null}
          </HealthWidget>
        ) : null}
      </section>
    </div>
  );
}
