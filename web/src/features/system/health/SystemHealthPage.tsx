import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Database,
  FileClock,
  HardDrive,
  RefreshCw,
  ServerCog,
  ShieldCheck,
} from "lucide-react";

import { useAuth } from "@/app/auth/AuthProvider";
import {
  formatBytes,
  formatInteger,
  formatMilliseconds,
  formatPercent,
  maxUpdatedAt,
  refreshIntervalMs,
} from "@/features/health/health-utils";
import { HealthWidget, UpdatedTime } from "@/features/health/health-ui";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import type { OpsStatus } from "@/shared/api/schemas";
import { Badge, type BadgeProps } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { usePreferences } from "@/shared/stores/preferences";

function scoreTier(score: number): "danger" | "success" | "warning" {
  if (score < 50) return "danger";
  if (score < 70) return "warning";
  return "success";
}

function riskFactorTone(severity: "critical" | "info" | "warning"): BadgeProps["tone"] {
  if (severity === "critical") return "danger";
  if (severity === "warning") return "warning";
  return "info";
}

function diskState(disk: OpsStatus["disk"]): { label: string; tone: BadgeProps["tone"] } {
  if (!disk.available) return { label: "Unavailable", tone: "danger" };
  if (disk.used_percent >= 90) return { label: "Critical", tone: "danger" };
  if (disk.used_percent >= 80) return { label: "Attention", tone: "warning" };
  return { label: "Available", tone: "success" };
}

export function SystemHealthPage(): React.JSX.Element {
  const refreshInterval = usePreferences((state) => state.refreshInterval);
  const interval = refreshIntervalMs(refreshInterval);
  const auth = useAuth();
  const showLegacyAdmin = canOpenLegacyAdmin(auth);

  const operations = useQuery({
    queryKey: ["admin", "ops", "risk"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.admin.ops.risk, {
        signal,
        routeId: "system.health",
      }),
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });

  const snapshot = operations.data?.status;
  const risk = operations.data?.risk;
  const providerFailure = snapshot?.partial_failures?.find((failure) => failure.component === "providers");
  const fallbackFailure = snapshot?.partial_failures?.find((failure) => failure.component === "fallback");
  const securityRisk = snapshot
    ? snapshot.security.dev_secret ||
      snapshot.security.raw_prompts_logged ||
      snapshot.security.raw_bodies_logged ||
      !snapshot.security.auth_enabled ||
      !snapshot.security.pricing_configured
    : false;
  const degraded =
    operations.isError ||
    Boolean(snapshot?.logging.dropped) ||
    snapshot?.disk.available === false ||
    securityRisk ||
    Boolean(snapshot?.partial_failures?.length) ||
    Boolean(risk?.factors.length) ||
    (risk?.tier !== undefined && risk.tier !== "low");
  const overallStatus = operations.isPending
    ? "Checking"
    : operations.isError && !operations.data
      ? "Disconnected"
      : degraded
        ? "Degraded"
        : "Healthy";
  const overallTone =
    overallStatus === "Healthy"
      ? "success"
      : overallStatus === "Checking"
        ? "muted"
        : overallStatus === "Degraded"
          ? "warning"
          : "danger";
  const updatedAt = maxUpdatedAt(operations.dataUpdatedAt);
  const refreshing = operations.isFetching;

  const refreshAll = (): void => {
    void operations.refetch();
  };

  const securityChecks = snapshot
    ? [
        {
          label: "인증",
          safe: snapshot.security.auth_enabled,
          detail: snapshot.security.auth_enabled ? "활성화됨" : "비활성화됨",
        },
        {
          label: "개발용 Secret",
          safe: !snapshot.security.dev_secret,
          detail: snapshot.security.dev_secret ? "운영에서 사용 중" : "사용하지 않음",
        },
        {
          label: "Prompt 원문 로깅",
          safe: !snapshot.security.raw_prompts_logged,
          detail: snapshot.security.raw_prompts_logged ? "활성화됨" : "비활성화됨",
        },
        {
          label: "Body 원문 로깅",
          safe: !snapshot.security.raw_bodies_logged,
          detail: snapshot.security.raw_bodies_logged ? "활성화됨" : "비활성화됨",
        },
        {
          label: "가격 설정",
          safe: snapshot.security.pricing_configured,
          detail: snapshot.security.pricing_configured ? "구성됨" : "구성 필요",
        },
      ]
    : [];

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <div className="eyebrow">Preview Read Only</div>
          <h1>System Health</h1>
          <p>로깅, 저장 공간, 보안 설정과 운영 위험의 현재 snapshot을 확인합니다.</p>
        </div>
        <div className="page-actions">
          <Badge tone="info">Read Only</Badge>
          <Badge tone={overallTone}>{overallStatus}</Badge>
          {showLegacyAdmin ? (
            <a className="button button-secondary button-default" href="/admin#/ops-home">
              Legacy에서 열기
            </a>
          ) : null}
          <Button onClick={refreshAll} disabled={refreshing}>
            <RefreshCw aria-hidden="true" /> 새로고침
          </Button>
        </div>
      </header>

      <div className="health-page-toolbar">
        <p className="metric-note">기간 집계가 아닌 Gateway의 최신 운영 snapshot입니다.</p>
        <div className="status-meta">
          <span>Backend {auth.backendVersion}</span>
          {updatedAt > 0 ? <UpdatedTime timestamp={updatedAt} /> : null}
        </div>
      </div>

      {operations.isError && !operations.data ? (
        <HealthWidget
          title="System Health snapshot"
          description="운영 상태와 위험도를 함께 조회합니다."
          icon={Activity}
          error={operations.error}
          onRetry={() => void operations.refetch()}
        />
      ) : (
        <section className="health-grid" aria-label="System Health 상세">
          <HealthWidget
            title="운영 위험"
            description="현재 설정과 상태에서 탐지한 위험 요인"
            icon={Activity}
            loading={operations.isPending}
            error={operations.error}
            onRetry={() => void operations.refetch()}
            updatedAt={operations.dataUpdatedAt || undefined}
            status={risk?.tier.toUpperCase()}
            statusTone={
              risk?.tier === "critical" || risk?.tier === "high"
                ? "danger"
                : risk?.tier === "medium"
                  ? "warning"
                  : "success"
            }
          >
            {risk ? (
              <>
                <div className="metric-value">
                  <strong>{risk.score}</strong>
                  <span>/ 100 risk score</span>
                </div>
                {risk.factors.length ? (
                  <ul className="health-alert-list" aria-label="위험 요인">
                    {risk.factors.map((factor) => (
                      <li key={factor.key}>
                        <ShieldCheck aria-hidden="true" />
                        <div>
                          <p>{factor.message}</p>
                          <small>{factor.key}</small>
                        </div>
                        <Badge tone={riskFactorTone(factor.severity)}>+{factor.points}</Badge>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="health-empty">
                    <ShieldCheck aria-hidden="true" />
                    <p>현재 탐지된 위험 요인이 없습니다.</p>
                  </div>
                )}
              </>
            ) : null}
          </HealthWidget>

          <HealthWidget
            title="로깅 Pipeline"
            description="비동기 로그 기록량과 누락 상태"
            icon={FileClock}
            loading={operations.isPending}
            updatedAt={operations.dataUpdatedAt || undefined}
            status={snapshot?.logging.dropped ? "Dropped" : snapshot ? "Normal" : undefined}
            statusTone={snapshot?.logging.dropped ? "danger" : "success"}
          >
            {snapshot ? (
              <dl className="metric-pairs">
                <div>
                  <dt>Queue depth</dt>
                  <dd>{formatInteger(snapshot.logging.queue_depth)}</dd>
                </div>
                <div>
                  <dt>기록 완료</dt>
                  <dd>{formatInteger(snapshot.logging.written)}</dd>
                </div>
                <div>
                  <dt>누락</dt>
                  <dd>{formatInteger(snapshot.logging.dropped)}</dd>
                </div>
              </dl>
            ) : null}
          </HealthWidget>

          <HealthWidget
            title="Security posture"
            description="민감 데이터와 운영 보안 설정 점검"
            icon={ShieldCheck}
            loading={operations.isPending}
            updatedAt={operations.dataUpdatedAt || undefined}
            status={securityRisk ? "Attention" : snapshot ? "Safe" : undefined}
            statusTone={securityRisk ? "warning" : "success"}
          >
            {snapshot ? (
              <ul className="health-check-list" aria-label="보안 설정 점검">
                {securityChecks.map((check) => (
                  <li key={check.label}>
                    <ShieldCheck aria-hidden="true" />
                    <div>
                      <p>{check.label}</p>
                      <small>{check.detail}</small>
                    </div>
                    <Badge tone={check.safe ? "success" : "danger"}>
                      {check.safe ? "안전" : "확인 필요"}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : null}
          </HealthWidget>

          <HealthWidget
            title="저장 공간과 Fallback"
            description="운영 데이터 경로와 fallback 파일 상태"
            icon={HardDrive}
            loading={operations.isPending}
            updatedAt={operations.dataUpdatedAt || undefined}
            status={
              snapshot ? (fallbackFailure ? "Partial failure" : diskState(snapshot.disk).label) : undefined
            }
            statusTone={snapshot ? (fallbackFailure ? "danger" : diskState(snapshot.disk).tone) : "muted"}
          >
            {snapshot ? (
              <>
                {fallbackFailure ? (
                  <div className="health-inline-warning" role="status">
                    <AlertTriangle aria-hidden="true" />
                    <p>{fallbackFailure.message}</p>
                  </div>
                ) : null}
                <dl className="metric-pairs">
                  <div>
                    <dt>디스크 사용</dt>
                    <dd>
                      {snapshot.disk.available
                        ? formatPercent(snapshot.disk.used_percent / 100)
                        : "확인 실패"}
                    </dd>
                  </div>
                  <div>
                    <dt>남은 공간</dt>
                    <dd>{snapshot.disk.available ? formatBytes(snapshot.disk.free_bytes) : "확인 실패"}</dd>
                  </div>
                  <div>
                    <dt>Fallback 행</dt>
                    <dd>{fallbackFailure ? "확인 실패" : formatInteger(snapshot.fallback.lines)}</dd>
                  </div>
                  <div>
                    <dt>Fallback 크기</dt>
                    <dd>{fallbackFailure ? "확인 실패" : formatBytes(snapshot.fallback.bytes)}</dd>
                  </div>
                </dl>
              </>
            ) : null}
          </HealthWidget>

          <HealthWidget
            title="Provider snapshot"
            description="System status 수집 시점의 Provider 점수"
            icon={ServerCog}
            loading={operations.isPending}
            updatedAt={operations.dataUpdatedAt || undefined}
            status={
              snapshot
                ? providerFailure
                  ? "Unavailable"
                  : `${snapshot.providers.length} providers`
                : undefined
            }
            statusTone={providerFailure ? "danger" : "muted"}
          >
            {providerFailure ? (
              <div className="health-empty health-partial-failure" role="status">
                <AlertTriangle aria-hidden="true" />
                <p>{providerFailure.message}</p>
              </div>
            ) : snapshot?.providers.length ? (
              <div className="health-table-wrap">
                <table className="health-table">
                  <caption className="sr-only">Provider 현재 운영 점수</caption>
                  <thead>
                    <tr>
                      <th scope="col">Provider</th>
                      <th scope="col">점수</th>
                      <th scope="col">요청</th>
                      <th scope="col">P95 지연</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.providers.map((provider) => (
                      <tr key={provider.provider}>
                        <td>{provider.provider}</td>
                        <td>
                          <span className="score-cell">
                            <span
                              className="score-dot"
                              data-tier={scoreTier(provider.score)}
                              aria-hidden="true"
                            />
                            {provider.score}
                          </span>
                        </td>
                        <td>{formatInteger(provider.requests)}</td>
                        <td>{formatMilliseconds(provider.p95_latency_ms)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : snapshot ? (
              <div className="health-empty">
                <Database aria-hidden="true" />
                <p>수집된 Provider 상태가 없습니다.</p>
              </div>
            ) : null}
          </HealthWidget>
        </section>
      )}
    </div>
  );
}
