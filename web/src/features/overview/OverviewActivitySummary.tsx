import { Bell, History, TriangleAlert } from "lucide-react";
import { useAuth } from "@/app/auth/AuthProvider";
import { useNavigationItems } from "@/app/layouts/use-navigation-items";
import { versionAtLeast } from "@/config/migration-registry";
import { HealthWidget } from "@/features/health/health-ui";
import {
  exactTime,
  formatInteger,
  healthRangeLabels,
  relativeTime,
  type HealthRange,
} from "@/features/health/health-utils";
import { apiClient } from "@/shared/api/client";
import { activitySummaryEndpoints } from "@/shared/api/domains/activity-summaries";
import { Badge } from "@/shared/components/ui/Badge";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { activityCategoryLabels, activityMetricLabels, activityOperationLabels } from "./activity-labels";
import { OverviewDestination } from "./OverviewDestination";
import { useOverviewQuery } from "./use-overview-query";

const panels = [
  {
    id: "incidents",
    featureId: "governance.policies",
    title: "장애 신호",
    label: "장애·정책 기록 열기",
    tab: "safety",
    icon: TriangleAlert,
  },
  {
    id: "alerts",
    featureId: "governance.policies",
    title: "최근 알림",
    label: "알림 기록 열기",
    tab: "safety",
    icon: Bell,
  },
  {
    id: "audit",
    featureId: "system.settings",
    title: "최근 관리 작업",
    label: "전체 변경 이력 열기",
    tab: "audit",
    icon: History,
  },
] as const;
type Panel = (typeof panels)[number];
type PanelProps = { range: HealthRange; interval: number | false };

function Destination({ panel }: { panel: Panel }) {
  return <OverviewDestination featureId={panel.featureId} label={panel.label} tab={panel.tab} />;
}
function EventTime({ at }: { at: string }) {
  return (
    <time dateTime={at} title={exactTime(new Date(at).getTime())}>
      {relativeTime(new Date(at).getTime())}
    </time>
  );
}

export function OverviewActivitySummary({ range, interval }: PanelProps) {
  const auth = useAuth();
  const navigation = useNavigationItems();
  const visible = panels.flatMap((panel) => {
    const item = navigation.find(({ feature }) => feature.featureId === panel.featureId);
    if (!item || (auth.user && !auth.user.scopes.includes("admin:read"))) return [];
    return [{ panel, legacy: item.effective.status === "legacy" }];
  });
  if (!visible.length) return null;
  return (
    <section className="page-stack overview-activity" aria-labelledby="overview-activity-title">
      <div>
        <h2 id="overview-activity-title">주의 신호와 최근 작업</h2>
        <p className="muted">
          전체 운영 범위 · {healthRangeLabels[range]} 기록입니다. 각 영역의 마지막 갱신 시각을 확인하세요.
        </p>
      </div>
      <div className="overview-activity-grid">
        {visible.map(({ panel, legacy }) =>
          legacy || !versionAtLeast(auth.backendVersion, "v0.86.129") ? (
            <HealthWidget key={panel.id} title={panel.title} icon={panel.icon} status="요약 미제공">
              <p>
                {legacy
                  ? "현재 전환 단계에서는 기존 화면에서 확인할 수 있습니다."
                  : "이 요약은 백엔드 v0.86.129 이상에서 제공됩니다."}
              </p>
              <Destination panel={panel} />
            </HealthWidget>
          ) : panel.id === "incidents" ? (
            <Incidents key={panel.id} range={range} interval={interval} />
          ) : panel.id === "alerts" ? (
            <Alerts key={panel.id} range={range} interval={interval} />
          ) : (
            <Audit key={panel.id} range={range} interval={interval} />
          ),
        )}
      </div>
    </section>
  );
}

function Incidents({ range, interval }: PanelProps) {
  const auth = useAuth();
  const panel = panels[0];
  const query = useOverviewQuery({
    key: ["activity-incidents", range],
    interval,
    read: (signal) =>
      apiClient.request(activitySummaryEndpoints.incidents, {
        query: { window: range },
        signal,
        routeId: "overview.incidents",
      }),
  });
  const data = query.data;
  return (
    <HealthWidget
      title={panel.title}
      icon={panel.icon}
      description="시간대별 대체 경로 전환·서버 오류 집계"
      loading={query.isPending}
      error={query.error}
      onRetry={query.refetch}
      updatedAt={query.dataUpdatedAt || undefined}
      status={
        query.isError
          ? "갱신 실패"
          : data
            ? data.current_hour
              ? "현재 시간대 신호 있음"
              : data.total
                ? "이전 시간대 신호"
                : "임계치 초과 없음"
            : undefined
      }
      statusTone={query.isError || data?.current_hour ? "warning" : "muted"}
      errorActions={<Destination panel={panel} />}
    >
      {data ? (
        <>
          <p className="overview-activity-count">
            <strong>{formatInteger(data.total)}개</strong> 신호 묶음 · 현재 시간대{" "}
            {formatInteger(data.current_hour)}개
          </p>
          {data.signals.length ? (
            <ol className="overview-activity-list" aria-label="장애 신호 목록">
              {data.signals.map((signal, index) => (
                <li key={`${signal.started_at}-${index}`}>
                  <div className="overview-activity-row">
                    <strong>
                      {signal.provider.startsWith("[") ||
                      containsPotentialSecret(signal.provider, auth.credentialPrefixes)
                        ? "공급자 정보 숨김"
                        : signal.provider}
                    </strong>
                    <Badge tone={signal.current_hour ? "warning" : "muted"}>
                      {signal.current_hour ? "현재 시간대" : "이전 시간대"}
                    </Badge>
                  </div>
                  <p>
                    대체 경로 {formatInteger(signal.failovers)}건 · 서버 오류{" "}
                    {formatInteger(signal.errors_5xx)}건
                  </p>
                  <p>해당 구간 요청 {formatInteger(signal.requests)}건</p>
                  <p className="muted">
                    <time dateTime={signal.started_at}>
                      {exactTime(new Date(signal.started_at).getTime())}
                    </time>{" "}
                    ~ <time dateTime={signal.ended_at}>{exactTime(new Date(signal.ended_at).getTime())}</time>
                  </p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">
              선택 기간에 기준을 넘긴 시간대가 없습니다. 전체 서비스의 정상 동작을 보장하는 결과는 아닙니다.
            </p>
          )}
          {data.total > data.signals.length ? (
            <p className="muted">현재 시간대 우선, 시작 시각순으로 최대 5개를 표시합니다.</p>
          ) : null}
          <details className="overview-activity-help">
            <summary>집계 기준 보기</summary>
            <p className="muted">
              같은 공급자의 UTC 기준 시간당 대체 경로 전환 또는 서버 오류가 각각 5건 이상이면 인접 시간대를
              묶습니다. 두 건수는 겹칠 수 있습니다. 표시 시각은 시간대 경계이며 선택 기간 밖까지 걸칠 수
              있습니다.
            </p>
          </details>
          <p className="muted">현재 시간대 신호는 진행 중인 장애 확정이나 복구 여부를 뜻하지 않습니다.</p>
        </>
      ) : null}
      <Destination panel={panel} />
    </HealthWidget>
  );
}

function Alerts({ range, interval }: PanelProps) {
  const panel = panels[1];
  const query = useOverviewQuery({
    key: ["activity-alerts", range],
    interval,
    read: (signal) =>
      apiClient.request(activitySummaryEndpoints.alerts, {
        query: { window: range },
        signal,
        routeId: "overview.alerts",
      }),
  });
  const data = query.data;
  const failed = data?.events.some((event) => event.delivery_failed);
  const format = (value: number) =>
    new Intl.NumberFormat("ko-KR", { maximumSignificantDigits: 6 }).format(value);
  return (
    <HealthWidget
      title={panel.title}
      icon={panel.icon}
      description="선택 기간의 최신 알림 최대 5건"
      loading={query.isPending}
      error={query.error}
      onRetry={query.refetch}
      updatedAt={query.dataUpdatedAt || undefined}
      status={
        query.isError
          ? "갱신 실패"
          : data
            ? failed
              ? "전송 오류 기록"
              : data.events.length
                ? "발생 기록 있음"
                : "발생 기록 없음"
            : undefined
      }
      statusTone={query.isError || failed ? "warning" : "muted"}
      errorActions={<Destination panel={panel} />}
    >
      {data ? (
        <>
          {data.events.length ? (
            <ol className="overview-activity-list" aria-label="최근 알림 목록">
              {data.events.map((event, index) => (
                <li key={`${event.created_at}-${index}`}>
                  <div className="overview-activity-row">
                    <strong>{activityMetricLabels[event.metric]}</strong>
                    <EventTime at={event.created_at} />
                  </div>
                  <p>
                    관측값 {format(event.value)} · 기준값 {format(event.threshold)}
                  </p>
                  <Badge tone={event.delivery_failed ? "warning" : "muted"}>
                    {event.delivery_failed ? "전송 오류" : event.delivered ? "전송 성공" : "전송 확인 없음"}
                  </Badge>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">
              선택 기간에 저장된 알림이 없습니다. 알림 규칙과 전송 설정은 상세 화면에서 확인하세요.
            </p>
          )}
          {data.has_more ? <p className="muted">최신 5건 외에 추가 기록이 있습니다.</p> : null}
          <p className="muted">전송 확인 없음은 전송 대상 미설정 등을 포함하며 오류와 구분됩니다.</p>
        </>
      ) : null}
      <Destination panel={panel} />
    </HealthWidget>
  );
}

function Audit({ range, interval }: PanelProps) {
  const panel = panels[2];
  const query = useOverviewQuery({
    key: ["activity-audit", range],
    interval,
    read: (signal) =>
      apiClient.request(activitySummaryEndpoints.audit, {
        query: { window: range },
        signal,
        routeId: "overview.audit",
      }),
  });
  const data = query.data;
  return (
    <HealthWidget
      title={panel.title}
      icon={panel.icon}
      description="선택 기간의 최신 관리 기록 최대 5건"
      loading={query.isPending}
      error={query.error}
      onRetry={query.refetch}
      updatedAt={query.dataUpdatedAt || undefined}
      status={
        query.isError ? "갱신 실패" : data ? (data.changes.length ? "기록 있음" : "기록 없음") : undefined
      }
      statusTone={query.isError ? "warning" : "muted"}
      errorActions={<Destination panel={panel} />}
    >
      {data ? (
        <>
          {data.changes.length ? (
            <ol className="overview-activity-list" aria-label="최근 관리 작업 목록">
              {data.changes.map((change, index) => (
                <li key={`${change.created_at}-${index}`}>
                  <div className="overview-activity-row">
                    <strong>{activityCategoryLabels[change.category]}</strong>
                    <EventTime at={change.created_at} />
                  </div>
                  <p>{activityOperationLabels[change.operation]}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">선택 기간에 저장된 관리 작업 기록이 없습니다.</p>
          )}
          {data.has_more ? <p className="muted">최신 5건 외에 추가 기록이 있습니다.</p> : null}
          <p className="muted">
            작업 종류와 시각만 표시합니다. 작업자와 변경 전후 내용은 권한에 따라 전체 변경 이력에서
            확인하세요.
          </p>
        </>
      ) : null}
      <Destination panel={panel} />
    </HealthWidget>
  );
}
