import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import {
  Activity,
  CheckCircle2,
  ExternalLink,
  Gauge,
  HeartPulse,
  RefreshCw,
  Route,
  ShieldAlert,
  Unplug,
} from "lucide-react";

import { useAuth } from "@/app/auth/AuthProvider";
import "@/features/gateway/gateway.css";
import { useBalancerState, useHealthActions } from "@/features/gateway/health/use-health-actions";
import { healthStatusLabels, uiLabels } from "@/config/ui-labels";
import {
  formatInteger,
  formatMilliseconds,
  formatPercent,
  healthRangeLabels,
  refreshIntervalMs,
} from "@/features/health/health-utils";
import { HealthWidget, TimeRangePicker } from "@/features/health/health-ui";
import { useHealthRange } from "@/features/health/use-health-range";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { isProviderRef, isSafeLegacyProviderName, providerDisplayLabel } from "@/shared/api/provider-ref";
import type { RoutingHealth } from "@/shared/api/schemas";
import { Badge, type BadgeProps } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { operationalMessage } from "@/shared/errors/operational-messages";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { usePreferences } from "@/shared/stores/preferences";

const routeId = "gateway.health";
const scoreThreshold = 70;

function scoreTier(score: number): "danger" | "success" | "warning" {
  if (score < 50) return "danger";
  if (score < scoreThreshold) return "warning";
  return "success";
}

function phaseLabel(phase: RoutingHealth["breakers"]["states"][number]["phase"]): string {
  switch (phase) {
    case "closed":
      return "정상(닫힘)";
    case "half_open":
      return "복구 확인(반개방)";
    case "open":
      return "차단(개방)";
  }
}

function severityTone(severity: RoutingHealth["alerts"][number]["severity"]): BadgeProps["tone"] {
  if (severity === "critical") return "danger";
  if (severity === "warning") return "warning";
  return "info";
}

function severityLabel(severity: RoutingHealth["alerts"][number]["severity"]): string {
  if (severity === "critical") return "심각";
  if (severity === "warning") return "경고";
  return "정보";
}

function hasOpenBreaker(data: RoutingHealth | undefined): boolean {
  return data?.breakers.states.some((state) => state.phase !== "closed") ?? false;
}

function routingProviderLabel(provider: string, providerRef: string | undefined, index: number): string {
  return isProviderRef(providerRef)
    ? providerDisplayLabel(provider, providerRef, provider === "[provider-name-omitted]")
    : `공급자 확인 불가 · ${index + 1}`;
}

interface BreakerActions {
  canWrite: boolean;
  deniedReason?: string;
  onReset: (provider: string, label: string) => void;
  pending: boolean;
}

export function GatewayHealthPage(): React.JSX.Element {
  const auth = useAuth();
  const showLegacyAdmin = canOpenLegacyAdmin(auth);
  const canWriteRouting = auth.user?.scopes.includes("routing:write") ?? false;
  const routingWriteDeniedReason = canWriteRouting
    ? undefined
    : "회로 차단기와 세션 고정 해제는 routing:write 권한이 필요합니다.";
  const refreshInterval = usePreferences((state) => state.refreshInterval);
  const interval = refreshIntervalMs(refreshInterval);
  const [range, setRange] = useHealthRange();
  const canReadRoutingBalancer = auth.user?.scopes.includes("routing:read") ?? false;

  const gateway = useQuery({
    queryKey: ["gateway", "health"],
    queryFn: ({ signal }) => apiClient.request(endpoints.health, { signal, routeId }),
    staleTime: 10_000,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
  const readiness = useQuery({
    queryKey: ["gateway", "readiness"],
    queryFn: ({ signal }) => apiClient.request(endpoints.ready, { signal, routeId }),
    staleTime: 10_000,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
  const routing = useQuery({
    queryKey: ["admin", "routing", "health", range],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.admin.routing.health, {
        query: { window: range, threshold: scoreThreshold },
        signal,
        routeId,
      }),
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });

  const gatewayHealthy = gateway.data?.status === "ok";
  const ready = readiness.data?.status === "ready";
  const routingDegraded =
    (routing.data?.degraded.length ?? 0) > 0 ||
    (routing.data?.alerts.some((alert) => alert.severity !== "info") ?? false) ||
    hasOpenBreaker(routing.data);
  const checking = gateway.isPending || readiness.isPending || routing.isPending;
  const disconnected = gateway.isError && !gateway.data;
  const degraded = gateway.isError || readiness.isError || routing.isError || routingDegraded;
  const pageState = disconnected ? "disconnected" : checking ? "checking" : degraded ? "degraded" : "healthy";
  const pageStatus = healthStatusLabels[pageState];
  const pageStatusTone: BadgeProps["tone"] = disconnected
    ? "danger"
    : checking
      ? "muted"
      : degraded
        ? "warning"
        : "success";
  const refreshing = gateway.isFetching || readiness.isFetching || routing.isFetching;

  const { releaseSessions, resetBreaker } = useHealthActions();
  const balancer = useBalancerState(canReadRoutingBalancer, range);
  const [confirming, setConfirming] = useState<
    { kind: "breaker" | "sessions"; provider: string; label: string } | undefined
  >();
  const actionReturnFocusRef = useRef<HTMLElement | null>(null);
  const rememberActionTrigger = (): void => {
    actionReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };

  const breakerActions: BreakerActions = {
    canWrite: canWriteRouting,
    deniedReason: routingWriteDeniedReason,
    pending: resetBreaker.isPending,
    onReset: (provider, label) => {
      rememberActionTrigger();
      setConfirming({ kind: "breaker", provider, label });
    },
  };

  const refreshAll = (): void => {
    void Promise.all([gateway.refetch(), readiness.refetch(), routing.refetch(), balancer.refetch()]);
  };

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <div className="eyebrow">{uiLabels.previewReadOnly}</div>
          <h1>게이트웨이 상태</h1>
          <p>게이트웨이 연결, 요청 준비 상태와 공급자 라우팅 상태를 안전하게 조회합니다.</p>
        </div>
        <div className="page-actions">
          <Badge tone="info">{uiLabels.readOnly}</Badge>
          <Badge tone={pageStatusTone}>{pageStatus}</Badge>
          {showLegacyAdmin ? (
            <a className="button button-secondary button-default" href="/admin#/routing/health">
              기존 상태 화면 열기 <ExternalLink aria-hidden="true" />
            </a>
          ) : null}
          <Button onClick={refreshAll} disabled={refreshing}>
            <RefreshCw aria-hidden="true" /> {refreshing ? "갱신 중" : "새로고침"}
          </Button>
        </div>
      </header>

      <div className="health-page-toolbar">
        <TimeRangePicker value={range} onChange={setRange} />
        <p className="metric-note">
          선택 기간은 공급자 점수, 순위와 라우팅 알림에 적용됩니다. 자동 갱신은 비활성 탭에서 중단됩니다.
        </p>
      </div>

      <section className="health-grid" aria-label="게이트웨이 기본 상태">
        <HealthWidget
          title="게이트웨이 연결"
          description="GET /health"
          icon={Activity}
          loading={gateway.isPending}
          error={gateway.error}
          onRetry={() => void gateway.refetch()}
          updatedAt={gateway.dataUpdatedAt || undefined}
          status={gatewayHealthy ? healthStatusLabels.healthy : undefined}
          statusTone={gatewayHealthy ? "success" : "muted"}
        >
          <div className="metric-value">
            <strong>{gatewayHealthy ? "정상" : "확인 필요"}</strong>
            <span>{gatewayHealthy ? "API 연결 가능" : "응답 상태 확인 필요"}</span>
          </div>
          <p className="metric-note">게이트웨이 프로세스가 상태 확인 요청에 정상 응답하는지 확인합니다.</p>
        </HealthWidget>

        <HealthWidget
          title="요청 준비 상태"
          description="GET /ready"
          icon={HeartPulse}
          loading={readiness.isPending}
          error={readiness.error}
          onRetry={() => void readiness.refetch()}
          updatedAt={readiness.dataUpdatedAt || undefined}
          status={ready ? "준비 완료" : undefined}
          statusTone={ready ? "success" : "muted"}
        >
          <div className="metric-value">
            <strong>{ready ? "준비 완료" : "확인 필요"}</strong>
            <span>{ready ? "요청 수신 가능" : "의존성 상태 확인 필요"}</span>
          </div>
          <p className="metric-note">
            게이트웨이가 필요한 의존성을 확인하고 실제 요청을 받을 준비가 되었는지 표시합니다.
          </p>
        </HealthWidget>
      </section>

      <HealthWidget
        title="공급자 라우팅 상태"
        description={`최근 ${healthRangeLabels[range]} · 점수 ${scoreThreshold} 미만을 저하로 판단`}
        icon={Route}
        loading={routing.isPending}
        error={routing.error}
        onRetry={() => void routing.refetch()}
        updatedAt={routing.dataUpdatedAt || undefined}
        status={
          routing.data
            ? routingDegraded
              ? healthStatusLabels.degraded
              : healthStatusLabels.healthy
            : undefined
        }
        statusTone={routingDegraded ? "warning" : "success"}
      >
        {routing.data ? <RoutingHealthDetails actions={breakerActions} data={routing.data} /> : null}
      </HealthWidget>

      <HealthWidget
        title="로드 밸런싱 · 세션 고정"
        description="GET /admin/routing/balancer"
        icon={Unplug}
        loading={balancer.isPending && canReadRoutingBalancer}
        error={balancer.error}
        onRetry={() => void balancer.refetch()}
        updatedAt={balancer.dataUpdatedAt || undefined}
      >
        {!canReadRoutingBalancer ? (
          <p className="metric-note">로드 밸런싱 상태는 routing:read 권한이 필요합니다.</p>
        ) : balancer.data ? (
          <div className="page-stack">
            <KeyValueList
              items={[
                { label: "분배 방식", value: balancer.data.mode ?? "-" },
                { label: "다중 인스턴스 안전", value: balancer.data.multi_instance_safe ? "예" : "아니오" },
                { label: "세션 고정", value: balancer.data.sticky_sessions ? "사용" : "미사용" },
                { label: "고정 유지 시간", value: balancer.data.sticky_ttl ?? "-" },
                { label: "활성 세션", value: formatInteger(balancer.data.active_sessions ?? 0) },
                { label: "분배 균형 지수", value: formatPercent(balancer.data.balance_index ?? 0) },
              ]}
            />
            {routingWriteDeniedReason ? (
              <InlineNotice tone="warning" title="조작 권한이 없습니다.">
                {routingWriteDeniedReason}
              </InlineNotice>
            ) : null}
            <Button
              variant="secondary"
              disabled={!canWriteRouting || releaseSessions.isPending}
              title={routingWriteDeniedReason}
              onClick={() => {
                rememberActionTrigger();
                setConfirming({ kind: "sessions", provider: "", label: "전체 공급자" });
              }}
            >
              세션 고정 전체 해제
            </Button>
          </div>
        ) : null}
      </HealthWidget>

      <ConfirmDialog
        open={confirming !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined);
        }}
        returnFocusRef={actionReturnFocusRef}
        title={confirming?.kind === "sessions" ? "세션 고정 해제" : "회로 차단기 해제"}
        description={
          confirming?.kind === "sessions"
            ? `${confirming.label}의 세션 고정을 해제합니다. 진행 중인 대화가 다른 공급자로 옮겨갈 수 있습니다.`
            : `${confirming?.label ?? ""}의 회로 차단기를 해제합니다. 아직 복구되지 않았다면 오류가 다시 발생할 수 있습니다.`
        }
        confirmLabel="해제"
        onConfirm={async () => {
          if (!confirming) return;
          if (confirming.kind === "sessions") await releaseSessions.mutateAsync(confirming.provider);
          else await resetBreaker.mutateAsync(confirming.provider);
          setConfirming(undefined);
        }}
      />
    </div>
  );
}

function RoutingHealthDetails({
  actions,
  data,
}: {
  actions: BreakerActions;
  data: RoutingHealth;
}): React.JSX.Element {
  return (
    <div className="page-stack">
      <section aria-labelledby="provider-ranking-title">
        <h3 id="provider-ranking-title">공급자 순위</h3>
        {data.ranking.length > 0 ? (
          <div className="health-table-wrap">
            <table className="health-table">
              <caption className="sr-only">선택 기간의 공급자 상태 점수 순위</caption>
              <thead>
                <tr>
                  <th scope="col">순위</th>
                  <th scope="col">공급자</th>
                  <th scope="col">점수</th>
                  <th scope="col">요청</th>
                  <th scope="col">P95 지연</th>
                  <th scope="col">장애 전환</th>
                </tr>
              </thead>
              <tbody>
                {data.ranking.map((provider, index) => (
                  <tr key={isProviderRef(provider.provider_ref) ? provider.provider_ref : `ranking-${index}`}>
                    <td>{formatInteger(provider.rank)}</td>
                    <td>{routingProviderLabel(provider.provider, provider.provider_ref, index)}</td>
                    <td>
                      <span className="score-cell">
                        <span
                          className="score-dot"
                          data-tier={scoreTier(provider.score)}
                          aria-hidden="true"
                        />
                        {formatInteger(provider.score)}점
                      </span>
                    </td>
                    <td>{formatInteger(provider.requests)}</td>
                    <td>{formatMilliseconds(provider.p95_latency_ms)}</td>
                    <td>{formatPercent(provider.fallback_rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="health-empty">
            <Gauge aria-hidden="true" />
            <p>선택 기간에 공급자 요청 데이터가 없습니다.</p>
          </div>
        )}
      </section>

      <section aria-labelledby="breaker-state-title">
        <h3 id="breaker-state-title">회로 차단기</h3>
        <div className="gateway-row-actions">
          <Button
            size="small"
            variant="secondary"
            disabled={!actions.canWrite || actions.pending || data.breakers.states.length === 0}
            title={actions.deniedReason}
            onClick={() => actions.onReset("", "전체 공급자")}
          >
            전체 해제
          </Button>
        </div>
        <dl className="metric-pairs">
          <div>
            <dt>기능 상태</dt>
            <dd>{data.breakers.enabled ? "활성" : "비활성"}</dd>
          </div>
          <div>
            <dt>공유 상태</dt>
            <dd>{data.breakers.shared ? "인스턴스 간 공유" : "현재 인스턴스 전용"}</dd>
          </div>
          <div>
            <dt>실패 임계값</dt>
            <dd>{formatInteger(data.breakers.threshold)}회</dd>
          </div>
          <div>
            <dt>복구 대기</dt>
            <dd>{formatInteger(data.breakers.cooldown_seconds)}초</dd>
          </div>
        </dl>
        {data.breakers.states.length > 0 ? (
          <div className="health-table-wrap">
            <table className="health-table">
              <caption className="sr-only">공급자별 회로 차단기 상태</caption>
              <thead>
                <tr>
                  <th scope="col">공급자</th>
                  <th scope="col">상태</th>
                  <th scope="col">연속 실패</th>
                  <th scope="col">차단 횟수</th>
                  <th scope="col">재시도까지</th>
                  <th scope="col">조치</th>
                </tr>
              </thead>
              <tbody>
                {data.breakers.states.map((breaker, index) => (
                  <tr key={isProviderRef(breaker.provider_ref) ? breaker.provider_ref : `breaker-${index}`}>
                    <td>{routingProviderLabel(breaker.provider, breaker.provider_ref, index)}</td>
                    <td>{phaseLabel(breaker.phase)}</td>
                    <td>{formatInteger(breaker.failures)}</td>
                    <td>{formatInteger(breaker.opens)}</td>
                    <td>
                      {breaker.retry_in_seconds === undefined
                        ? "-"
                        : `${formatInteger(breaker.retry_in_seconds)}초`}
                    </td>
                    <td>
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={
                          !actions.canWrite || actions.pending || !isSafeLegacyProviderName(breaker.provider)
                        }
                        title={
                          actions.deniedReason ??
                          (isSafeLegacyProviderName(breaker.provider)
                            ? undefined
                            : "공급자 이름이 비공개 처리되어 개별 해제할 수 없습니다. 전체 해제를 사용하세요.")
                        }
                        onClick={() =>
                          actions.onReset(
                            breaker.provider,
                            routingProviderLabel(breaker.provider, breaker.provider_ref, index),
                          )
                        }
                      >
                        해제
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="metric-note">공급자별 회로 차단기 상태가 아직 없습니다.</p>
        )}
      </section>

      <section aria-labelledby="routing-alert-title">
        <h3 id="routing-alert-title">라우팅 알림</h3>
        {data.alerts.length > 0 ? (
          <ul className="health-alert-list">
            {data.alerts.map((alert, index) => (
              <li
                key={
                  isProviderRef(alert.provider_ref)
                    ? `${alert.provider_ref}-${alert.code}-${index}`
                    : `alert-${alert.code}-${index}`
                }
              >
                <ShieldAlert aria-hidden="true" />
                <div>
                  <p>{operationalMessage(alert.code, "라우팅 알림의 상세 내용을 확인할 수 없습니다.")}</p>
                  <small>
                    {routingProviderLabel(alert.provider, alert.provider_ref, index)} · 진단 코드:{" "}
                    {alert.code}
                  </small>
                </div>
                <Badge tone={severityTone(alert.severity)}>{severityLabel(alert.severity)}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <div className="health-empty">
            <CheckCircle2 aria-hidden="true" />
            <p>활성 라우팅 알림이 없습니다.</p>
          </div>
        )}
      </section>
    </div>
  );
}
