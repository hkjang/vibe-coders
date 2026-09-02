import { useQuery } from "@tanstack/react-query";
import { Activity, CircleDollarSign, RefreshCw, Route, ShieldAlert } from "lucide-react";

import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { usePreferences } from "@/shared/stores/preferences";

function exactTime(timestamp: number): string {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "medium" }).format(timestamp);
}

export function OverviewPage(): React.JSX.Element {
  const refreshInterval = usePreferences((state) => state.refreshInterval);
  const auth = useAuth();
  const { backendVersion } = auth;
  const showLegacyAdmin = canOpenLegacyAdmin(auth);
  const health = useQuery({
    queryKey: ["gateway", "health"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.health, {
        signal,
        routeId: "overview",
      }),
    refetchInterval: refreshInterval ? refreshInterval * 1_000 : false,
    refetchIntervalInBackground: false,
  });

  const healthy = health.data?.status === "ok";
  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <div className="eyebrow">Preview Read Only</div>
          <h1>운영 Overview</h1>
          <p>Gateway 상태, 트래픽, 비용과 위험 신호를 빠르게 확인합니다.</p>
        </div>
        <div className="page-actions">
          <Badge tone={healthy ? "success" : health.isError ? "danger" : "muted"}>
            {healthy ? "Healthy" : health.isError ? "Disconnected" : "Checking"}
          </Badge>
          <Button onClick={() => void health.refetch()} disabled={health.isFetching}>
            <RefreshCw aria-hidden="true" /> 새로고침
          </Button>
        </div>
      </header>

      <section className="status-banner" aria-labelledby="gateway-health-title">
        <div className="status-icon" data-status={healthy ? "healthy" : "unknown"}>
          <Activity aria-hidden="true" />
        </div>
        <div>
          <h2 id="gateway-health-title">Gateway Health</h2>
          {health.isPending ? <p>Gateway 연결을 확인하는 중입니다.</p> : null}
          {healthy ? <p>Gateway가 요청을 처리할 준비가 되었습니다.</p> : null}
          {health.isError ? <p>상태 확인에 실패했습니다. API 서비스와 Legacy Admin을 확인하세요.</p> : null}
        </div>
        <div className="status-meta">
          <span>Backend {backendVersion}</span>
          {health.dataUpdatedAt ? (
            <time
              dateTime={new Date(health.dataUpdatedAt).toISOString()}
              title={exactTime(health.dataUpdatedAt)}
            >
              마지막 확인 {exactTime(health.dataUpdatedAt)}
            </time>
          ) : null}
        </div>
      </section>

      <section className="overview-grid" aria-label="운영 영역 요약">
        <article className="metric-card">
          <div className="metric-card-heading">
            <Activity aria-hidden="true" /> <h2>트래픽</h2>
          </div>
          <strong>Legacy 데이터</strong>
          <p>요청·지연 상세는 전환 전까지 기존 화면에서 확인합니다.</p>
          {showLegacyAdmin ? (
            <a href="/admin#/dashboard">트래픽 대시보드 열기</a>
          ) : (
            <span className="muted-copy">Legacy 이동이 비활성화되어 있습니다.</span>
          )}
        </article>
        <article className="metric-card">
          <div className="metric-card-heading">
            <CircleDollarSign aria-hidden="true" /> <h2>비용</h2>
          </div>
          <strong>Legacy 데이터</strong>
          <p>일간 비용과 예산 사용률을 기존 비용 대시보드에서 확인합니다.</p>
          {showLegacyAdmin ? (
            <a href="/admin#/billing">비용 대시보드 열기</a>
          ) : (
            <span className="muted-copy">Legacy 이동이 비활성화되어 있습니다.</span>
          )}
        </article>
        <article className="metric-card">
          <div className="metric-card-heading">
            <Route aria-hidden="true" /> <h2>라우팅</h2>
          </div>
          <strong>Legacy 데이터</strong>
          <p>Provider, Fallback과 Circuit Breaker 상태를 확인합니다.</p>
          {showLegacyAdmin ? (
            <a href="/admin#/routing">라우팅 화면 열기</a>
          ) : (
            <span className="muted-copy">Legacy 이동이 비활성화되어 있습니다.</span>
          )}
        </article>
        <article className="metric-card">
          <div className="metric-card-heading">
            <ShieldAlert aria-hidden="true" /> <h2>위험</h2>
          </div>
          <strong>Legacy 데이터</strong>
          <p>정책 차단, 승인 대기와 보안 이벤트를 확인합니다.</p>
          {showLegacyAdmin ? (
            <a href="/admin#/safety">안전 화면 열기</a>
          ) : (
            <span className="muted-copy">Legacy 이동이 비활성화되어 있습니다.</span>
          )}
        </article>
      </section>
    </div>
  );
}
