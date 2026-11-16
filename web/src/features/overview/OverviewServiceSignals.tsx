import { Database, Network } from "lucide-react";
import { useAuth } from "@/app/auth/AuthProvider";
import { useNavigationItems } from "@/app/layouts/use-navigation-items";
import { versionAtLeast } from "@/config/migration-registry";
import { HealthWidget } from "@/features/health/health-ui";
import {
  exactTime,
  formatInteger,
  formatKRW,
  formatPercent,
  healthRangeLabels,
  type HealthRange,
} from "@/features/health/health-utils";
import { apiClient } from "@/shared/api/client";
import { serviceSummaryEndpoints } from "@/shared/api/domains/service-summaries";
import { OverviewDestination } from "./OverviewDestination";
import { useOverviewQuery } from "./use-overview-query";

const services = [
  { id: "mcp.overview", title: "MCP 도구 호출", label: "MCP 상태 열기", icon: Network },
  { id: "text2sql.overview", title: "자연어 SQL 처리", label: "Text2SQL 현황 열기", icon: Database },
] as const;

export function OverviewServiceSignals({
  range,
  interval,
}: {
  range: HealthRange;
  interval: number | false;
}) {
  const auth = useAuth();
  const navigation = useNavigationItems();
  const visible = services.flatMap((service) => {
    const item = navigation.find(({ feature }) => feature.featureId === service.id);
    if (!item || (auth.user && !auth.user.scopes.includes("admin:read"))) return [];
    return [{ ...service, legacy: item.effective.status === "legacy" }];
  });
  if (!visible.length) return null;
  return (
    <section className="page-stack overview-service-signals" aria-labelledby="overview-service-title">
      <div>
        <h2 id="overview-service-title">연결 서비스</h2>
        <p className="muted">
          MCP는 최근 24시간, 자연어 SQL은 선택한 기간의 기록을 확인합니다. 연결 테스트 결과와는 별도입니다.
        </p>
      </div>
      <div className="health-grid">
        {visible.map((service) =>
          service.legacy || !versionAtLeast(auth.backendVersion, "v0.86.128") ? (
            <HealthWidget key={service.id} title={service.title} icon={service.icon} status="요약 미제공">
              <p>
                {service.legacy
                  ? "현재 전환 단계에서는 기존 화면에서 확인할 수 있습니다."
                  : "이 요약은 백엔드 v0.86.128 이상에서 제공됩니다."}
              </p>
              <OverviewDestination featureId={service.id} label={service.label} />
            </HealthWidget>
          ) : service.id === "mcp.overview" ? (
            <MCPServiceSignal key={service.id} interval={interval} />
          ) : (
            <Text2SQLServiceSignal key={service.id} range={range} interval={interval} />
          ),
        )}
      </div>
    </section>
  );
}

function MCPServiceSignal({ interval }: { interval: number | false }) {
  const query = useOverviewQuery({
    key: ["mcp-service"],
    interval,
    read: (signal) => apiClient.request(serviceSummaryEndpoints.mcp, { signal, routeId: "overview.mcp" }),
  });
  const data = query.data;
  const attention = Boolean(data && (data.recent_error_count > 0 || data.discovery_error_count > 0));
  const status = query.isError
    ? "갱신 실패"
    : data
      ? data.upstream_count === 0
        ? "미설정"
        : data.enabled_upstream_count === 0
          ? "비활성"
          : attention
            ? "확인 필요"
            : data.recent_call_count === 0
              ? "호출 없음"
              : "오류 기록 없음"
      : undefined;
  return (
    <HealthWidget
      errorActions={<OverviewDestination featureId={services[0].id} label={services[0].label} />}
      title={services[0].title}
      description="전체 MCP 서버 · 최근 24시간 호출 기록과 최근 발견 결과"
      icon={Network}
      loading={query.isPending}
      error={query.error}
      onRetry={query.refetch}
      updatedAt={query.dataUpdatedAt || undefined}
      status={status}
      statusTone={query.isError || attention ? "warning" : "muted"}
    >
      {data ? (
        <>
          <div className="metric-value">
            <strong>{formatInteger(data.recent_call_count)}</strong>
            <span>호출 기록</span>
          </div>
          <dl className="metric-pairs">
            <div>
              <dt>오류 기록</dt>
              <dd>{formatInteger(data.recent_error_count)}</dd>
            </div>
            <div>
              <dt>활성 서버 / 등록 서버</dt>
              <dd>
                {formatInteger(data.enabled_upstream_count)} / {formatInteger(data.upstream_count)}
              </dd>
            </div>
            <div>
              <dt>경로 발견 서버</dt>
              <dd>{formatInteger(data.healthy_upstream_count)}</dd>
            </div>
            <div>
              <dt>발견된 도구</dt>
              <dd>{formatInteger(data.total_tools)}</dd>
            </div>
            <div>
              <dt>발견 오류</dt>
              <dd>{formatInteger(data.discovery_error_count)}</dd>
            </div>
          </dl>
          <p className="muted">오류 기록은 호출·결과의 오류를 합산하며, 실패한 호출 수와 다를 수 있습니다.</p>
          <p className="muted">
            마지막 발견:{" "}
            {data.fetched_at.startsWith("0001-") ? (
              "발견 기록 없음"
            ) : (
              <time dateTime={data.fetched_at}>{exactTime(Date.parse(data.fetched_at))}</time>
            )}
          </p>
        </>
      ) : null}
      <div className="overview-destinations">
        <OverviewDestination featureId={services[0].id} label={services[0].label} />
      </div>
    </HealthWidget>
  );
}

function Text2SQLServiceSignal({ range, interval }: { range: HealthRange; interval: number | false }) {
  const query = useOverviewQuery({
    key: ["text2sql-service", range],
    interval,
    read: (signal) =>
      apiClient.request(serviceSummaryEndpoints.text2sql, {
        signal,
        query: { window: range },
        routeId: "overview.text2sql",
      }),
  });
  const data = query.data;
  const stats = data?.stats;
  const attention = Boolean(stats && (stats.errors > 0 || stats.valid < stats.total));
  const status = query.isError
    ? "갱신 실패"
    : data
      ? !data.enabled
        ? "비활성"
        : stats?.total === 0
          ? "처리 기록 없음"
          : attention
            ? "확인 필요"
            : "검증 통과"
      : undefined;
  return (
    <HealthWidget
      errorActions={<OverviewDestination featureId={services[1].id} label={services[1].label} />}
      title={services[1].title}
      description={`${healthRangeLabels[range]} · 현재 계정의 조회 범위 · 그림자 실행 제외`}
      icon={Database}
      loading={query.isPending}
      error={query.error}
      onRetry={query.refetch}
      updatedAt={query.dataUpdatedAt || undefined}
      status={status}
      statusTone={query.isError || attention ? "warning" : "muted"}
    >
      {stats ? (
        <>
          <div className="metric-value">
            <strong>{stats.total ? formatPercent(stats.valid_rate) : "—"}</strong>
            <span>검증 통과율</span>
          </div>
          <dl className="metric-pairs">
            <div>
              <dt>전체 처리</dt>
              <dd>{formatInteger(stats.total)}</dd>
            </div>
            <div>
              <dt>검증 미통과</dt>
              <dd>{formatInteger(stats.total - stats.valid)}</dd>
            </div>
            <div>
              <dt>실행 기록</dt>
              <dd>{formatInteger(stats.executed)}</dd>
            </div>
            <div>
              <dt>오류 기록</dt>
              <dd>{formatInteger(stats.errors)}</dd>
            </div>
            <div>
              <dt>사용 비용</dt>
              <dd>{formatKRW(stats.cost_krw)}</dd>
            </div>
          </dl>
          <p className="muted">
            검증 통과율은 SQL 실행 성공률이 아닙니다. 검증 미통과와 오류 기록은 중복될 수 있습니다.
          </p>
        </>
      ) : null}
      <div className="overview-destinations">
        <OverviewDestination featureId={services[1].id} label={services[1].label} />
      </div>
    </HealthWidget>
  );
}
