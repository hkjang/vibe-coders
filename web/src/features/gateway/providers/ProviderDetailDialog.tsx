import { AlertTriangle, ExternalLink, RefreshCw } from "lucide-react";
import type { RefObject } from "react";

import {
  displayProviderBaseURL,
  type ProviderCatalogRow,
} from "@/features/gateway/providers/provider-catalog";
import { formatInteger, formatMilliseconds, formatPercent } from "@/features/health/health-utils";
import { isAppError } from "@/shared/api/error";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";

export interface ProviderDetailSourceState {
  error?: unknown;
  hasData: boolean;
  onRetry: () => void;
  pending: boolean;
  refreshing: boolean;
}

interface ProviderDetailDialogProps {
  canReadRouting: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  providerState: ProviderDetailSourceState;
  requestedName: string;
  returnFocusRef: RefObject<HTMLElement | null>;
  routingState: ProviderDetailSourceState;
  row?: ProviderCatalogRow;
  showLegacyAdmin: boolean;
  sloState: ProviderDetailSourceState;
}

const healthLabels = {
  checking: "Checking",
  healthy: "Healthy",
  degraded: "Degraded",
  unknown: "Unknown",
} as const;

function formatDate(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "medium" }).format(timestamp);
}

function DetailQueryState({
  label,
  state,
}: {
  label: string;
  state: ProviderDetailSourceState;
}): React.JSX.Element | null {
  if (state.error) {
    const requestId = isAppError(state.error) ? state.error.requestId : undefined;
    return (
      <div className="provider-detail-query-state provider-detail-query-error" role="alert">
        <AlertTriangle aria-hidden="true" />
        <div>
          <strong>
            {label}{" "}
            {state.hasData ? "갱신에 실패해 마지막 정상 데이터를 표시합니다." : "조회에 실패했습니다."}
          </strong>
          <p>{isAppError(state.error) ? state.error.message : "잠시 후 다시 시도해 주세요."}</p>
          {requestId ? <code>Request ID: {requestId}</code> : null}
          {state.refreshing ? <span>다시 갱신하는 중입니다.</span> : null}
        </div>
        <Button
          aria-label={`${label} 재시도`}
          disabled={state.refreshing}
          onClick={state.onRetry}
          size="small"
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" /> {state.refreshing ? "갱신 중" : "재시도"}
        </Button>
      </div>
    );
  }
  if (state.pending && !state.hasData) {
    return (
      <div className="provider-detail-query-state" role="status">
        <RefreshCw aria-hidden="true" />
        <span>{label} 확인 중입니다.</span>
      </div>
    );
  }
  if (state.refreshing) {
    return (
      <div className="provider-detail-query-state" role="status">
        <RefreshCw aria-hidden="true" />
        <span>{label} 갱신 중입니다. 마지막 정상 데이터를 계속 표시합니다.</span>
      </div>
    );
  }
  return null;
}

function SLODetails({ row }: { row: ProviderCatalogRow }): React.JSX.Element {
  const { evaluation, slo } = row;
  if (!slo) return <p className="provider-detail-empty">이 Provider에는 SLO가 설정되지 않았습니다.</p>;
  const metrics = evaluation?.metrics;
  return (
    <div className="provider-detail-section">
      <div className="provider-detail-heading">
        <h3>Service Level Objective</h3>
        <Badge tone={!slo.enabled ? "muted" : evaluation?.breached ? "danger" : "success"}>
          {!slo.enabled ? "비활성" : evaluation?.breached ? "위반" : "정상"}
        </Badge>
      </div>
      <dl className="provider-detail-grid">
        <div>
          <dt>가용성</dt>
          <dd>
            {metrics?.availability.enforced
              ? `${formatPercent(metrics.availability.actual)} / ${formatPercent(metrics.availability.target)}`
              : "목표 없음"}
          </dd>
        </div>
        <div>
          <dt>P95 지연</dt>
          <dd>
            {metrics?.p95_latency_ms.enforced
              ? `${formatMilliseconds(metrics.p95_latency_ms.actual)} / ${formatMilliseconds(metrics.p95_latency_ms.target)}`
              : "목표 없음"}
          </dd>
        </div>
        <div>
          <dt>오류율</dt>
          <dd>
            {metrics?.error_rate.enforced
              ? `${formatPercent(metrics.error_rate.actual)} / ${formatPercent(metrics.error_rate.target)}`
              : "목표 없음"}
          </dd>
        </div>
        <div>
          <dt>Fallback 비율</dt>
          <dd>
            {metrics?.fallback_rate.enforced
              ? `${formatPercent(metrics.fallback_rate.actual)} / ${formatPercent(metrics.fallback_rate.target)}`
              : "목표 없음"}
          </dd>
        </div>
      </dl>
      <p className="provider-detail-caption">
        선택 기간 요청 {formatInteger(evaluation?.requests ?? 0)}건 · SLO 갱신 {formatDate(slo.updated_at)}
      </p>
      {slo.note ? <p className="provider-detail-note">{slo.note}</p> : null}
    </div>
  );
}

function RoutingDetails({ row }: { row: ProviderCatalogRow }): React.JSX.Element {
  if (!row.routing) {
    return <p className="provider-detail-empty">선택 기간의 라우팅 상태 데이터가 없습니다.</p>;
  }
  return (
    <dl className="provider-detail-grid">
      <div>
        <dt>상태 점수</dt>
        <dd>{formatInteger(row.routing.score)}점</dd>
      </div>
      <div>
        <dt>요청</dt>
        <dd>{formatInteger(row.routing.requests)}건</dd>
      </div>
      <div>
        <dt>P95 지연</dt>
        <dd>{formatMilliseconds(row.routing.p95_latency_ms)}</dd>
      </div>
      <div>
        <dt>Fallback</dt>
        <dd>{formatPercent(row.routing.fallback_rate)}</dd>
      </div>
    </dl>
  );
}

export function ProviderDetailDialog({
  canReadRouting,
  onOpenChange,
  open,
  providerState,
  requestedName,
  returnFocusRef,
  routingState,
  row,
  showLegacyAdmin,
  sloState,
}: ProviderDetailDialogProps): React.JSX.Element {
  const footer = showLegacyAdmin ? (
    <a className="button button-secondary button-default" href="/admin#/settings">
      Legacy 설정 열기 <ExternalLink aria-hidden="true" />
    </a>
  ) : undefined;

  return (
    <Dialog
      description="Provider 연결 설정과 선택 기간의 운영 신호를 읽기 전용으로 확인합니다."
      footer={footer}
      onOpenChange={onOpenChange}
      open={open}
      returnFocusRef={returnFocusRef}
      title={row?.provider.name ?? (requestedName || "Provider 상세")}
    >
      {providerState.pending && !row ? (
        <div className="provider-detail-loading" role="status">
          상세 정보를 불러오는 중입니다.
        </div>
      ) : providerState.error && !row ? (
        <DetailQueryState label="Provider 설정" state={providerState} />
      ) : !row ? (
        <div className="provider-detail-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <div>
            <strong>Provider를 찾을 수 없습니다.</strong>
            <p>현재 목록에 “{requestedName}” Provider가 없습니다.</p>
          </div>
        </div>
      ) : (
        <div className="provider-detail-stack">
          <DetailQueryState label="Provider 설정" state={providerState} />
          <div className="provider-detail-heading">
            <div className="provider-detail-badges">
              <Badge tone={row.provider.enabled ? "success" : "muted"}>
                {row.provider.enabled ? "활성" : "비활성"}
              </Badge>
              <Badge
                tone={
                  row.health === "healthy"
                    ? "success"
                    : row.health === "degraded"
                      ? "warning"
                      : row.health === "checking"
                        ? "info"
                        : "muted"
                }
              >
                {healthLabels[row.health]}
              </Badge>
              <Badge tone={row.provider.api_key_configured ? "info" : "muted"}>
                {row.provider.api_key_configured ? "Secret 설정됨" : "Secret 없음"}
              </Badge>
            </div>
          </div>

          <section className="provider-detail-section" aria-labelledby="provider-connection-title">
            <h3 id="provider-connection-title">연결 설정</h3>
            <dl className="provider-detail-grid">
              <div className="provider-detail-wide">
                <dt>Base URL</dt>
                <dd>
                  <code>{displayProviderBaseURL(row.provider.base_url)}</code>
                </dd>
              </div>
              <div>
                <dt>Timeout</dt>
                <dd>{formatInteger(row.provider.timeout_ms)} ms</dd>
              </div>
              <div>
                <dt>Priority</dt>
                <dd>{formatInteger(row.provider.priority)}</dd>
              </div>
              <div>
                <dt>Failover Group</dt>
                <dd>{row.provider.failover_group || "설정 없음"}</dd>
              </div>
              <div>
                <dt>등록 시각</dt>
                <dd>{formatDate(row.provider.created_at)}</dd>
              </div>
              <div className="provider-detail-wide">
                <dt>Model Patterns</dt>
                <dd>
                  <code>{row.provider.model_patterns || "모든 모델"}</code>
                </dd>
              </div>
            </dl>
          </section>

          <section className="provider-detail-section" aria-labelledby="provider-slo-title">
            <h3 id="provider-slo-title" className="sr-only">
              Provider SLO
            </h3>
            <DetailQueryState label="Provider SLO" state={sloState} />
            {!sloState.pending && (!sloState.error || sloState.hasData) ? <SLODetails row={row} /> : null}
          </section>

          <section className="provider-detail-section" aria-labelledby="provider-routing-title">
            <h3 id="provider-routing-title">라우팅 상태</h3>
            {canReadRouting ? (
              <>
                <DetailQueryState label="Provider 라우팅 상태" state={routingState} />
                {!routingState.pending && (!routingState.error || routingState.hasData) ? (
                  <RoutingDetails row={row} />
                ) : null}
              </>
            ) : (
              <p className="provider-detail-empty">routing:read 권한이 없어 상세 신호를 표시하지 않습니다.</p>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
}
