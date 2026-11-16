import { useAuth } from "@/app/auth/AuthProvider";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { CheckCircle2, Gauge, ShieldAlert } from "lucide-react";
import { healthScoreThreshold as scoreThreshold } from "./health-constants";
import { formatInteger, formatMilliseconds, formatPercent } from "@/features/health/health-utils";
import { isProviderRef, isSafeLegacyProviderName, providerDisplayLabel } from "@/shared/api/provider-ref";
import type { RoutingHealth } from "@/shared/api/schemas";
import { Badge, type BadgeProps } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { operationalMessage } from "@/shared/errors/operational-messages";

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

function routingProviderLabel(
  provider: string,
  providerRef: string | undefined,
  index: number,
  prefixes: readonly string[],
): string {
  if (containsPotentialSecret(provider, prefixes)) provider = "[provider-name-omitted]";
  return isProviderRef(providerRef)
    ? providerDisplayLabel(provider, providerRef, provider === "[provider-name-omitted]")
    : `공급자 확인 불가 · ${index + 1}`;
}

export interface BreakerActions {
  canWrite: boolean;
  deniedReason?: string;
  onReset: (provider: string, label: string) => void;
  pending: boolean;
}

export function RoutingHealthDetails({
  actions,
  data,
}: {
  actions: BreakerActions;
  data: RoutingHealth;
}): React.JSX.Element {
  const { credentialPrefixes } = useAuth();
  const prefixes = credentialPrefixes ?? [];
  const canResetProvider = (name: string) =>
    isSafeLegacyProviderName(name) && !containsPotentialSecret(name, prefixes);
  return (
    <div className="page-stack">
      <section aria-labelledby="provider-ranking-title">
        <h3 id="provider-ranking-title">공급자 순위</h3>
        {data.ranking.length > 0 ? (
          <div className="health-table-wrap" role="region" aria-label="공급자 순위 표" tabIndex={0}>
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
                    <td>{routingProviderLabel(provider.provider, provider.provider_ref, index, prefixes)}</td>
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
          <div className="health-table-wrap" role="region" aria-label="회로 차단기 상태 표" tabIndex={0}>
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
                    <td>{routingProviderLabel(breaker.provider, breaker.provider_ref, index, prefixes)}</td>
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
                        disabled={!actions.canWrite || actions.pending || !canResetProvider(breaker.provider)}
                        title={
                          actions.deniedReason ??
                          (canResetProvider(breaker.provider)
                            ? undefined
                            : "공급자 이름이 비공개 처리되어 개별 해제할 수 없습니다. 전체 해제를 사용하세요.")
                        }
                        onClick={() =>
                          actions.onReset(
                            breaker.provider,
                            routingProviderLabel(breaker.provider, breaker.provider_ref, index, prefixes),
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
                    {routingProviderLabel(alert.provider, alert.provider_ref, index, prefixes)} · 진단 코드:{" "}
                    {alert.code.length <= 100 && !containsPotentialSecret(alert.code, prefixes)
                      ? alert.code
                      : "비공개"}
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
