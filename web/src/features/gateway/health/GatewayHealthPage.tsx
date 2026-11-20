import { legacyRoutes } from "@/config/legacy-route-map";
import { FeatureLegacyLink } from "@/shared/components/ui/FeatureLegacyLink";

import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Activity, ExternalLink, HeartPulse, RefreshCw, Route, Unplug } from "lucide-react";

import { useAuth } from "@/app/auth/AuthProvider";
import "@/features/gateway/gateway.css";
import "./health-workspace.css";
import { useHealthActions } from "./use-health-actions";
import { useHealthReads } from "./use-health-reads";
import { RoutingHealthDetails, type BreakerActions } from "./RoutingHealthDetails";
import { healthScoreThreshold as scoreThreshold } from "./health-constants";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { healthStatusLabels, uiLabels } from "@/config/ui-labels";
import { MigrationEyebrow } from "@/shared/components/page/MigrationStatus";
import {
  formatInteger,
  formatPercent,
  healthRangeLabels,
  refreshIntervalMs,
} from "@/features/health/health-utils";
import { HealthWidget, TimeRangePicker } from "@/features/health/health-ui";
import { useHealthRange } from "@/features/health/use-health-range";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import type { RoutingHealth } from "@/shared/api/schemas";
import { Badge, type BadgeProps } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { usePreferences } from "@/shared/stores/preferences";
import { featureReadonlyReason } from "@/shared/feature-access/policy";

const routeId = "gateway.health";

function hasOpenBreaker(data: RoutingHealth | undefined): boolean {
  return data?.breakers.states.some((state) => state.phase !== "closed") ?? false;
}

export function GatewayHealthPage(): React.JSX.Element {
  const auth = useAuth();
  const showLegacyAdmin = canOpenLegacyAdmin(auth);
  const { access, releaseSessions, resetBreaker } = useHealthActions();
  const writable = access.allowed;
  const routingWriteDeniedReason = access.reason;
  const runtimeReadonly = access.reason === featureReadonlyReason;
  const refreshInterval = usePreferences((state) => state.refreshInterval);
  const interval = refreshIntervalMs(refreshInterval);
  const [range, setRange] = useHealthRange();
  const { owner, routing, balancer, isSnapshotCurrent } = useHealthReads(range, interval);
  const canWriteRouting = writable && owner.readable && !owner.denied;
  const resetPending = resetBreaker.isPending && resetBreaker.variables?.owner === owner;
  const sessionsPending = releaseSessions.isPending && releaseSessions.variables?.owner === owner;

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

  const gatewayHealthy = gateway.data?.status === "ok";
  const ready = readiness.data?.status === "ready";
  const routingDegraded =
    (routing.data?.degraded.length ?? 0) > 0 ||
    (routing.data?.alerts.some((alert) => alert.severity !== "info") ?? false) ||
    hasOpenBreaker(routing.data);
  const checking = gateway.isPending || readiness.isPending || routing.isPending;
  const disconnected = gateway.isError && !gateway.data;
  const degraded =
    gateway.isError ||
    readiness.isError ||
    routing.isError ||
    balancer.isError ||
    routingDegraded ||
    !owner.readable ||
    owner.denied;
  const pageState = disconnected ? "disconnected" : checking ? "checking" : degraded ? "degraded" : "healthy";
  const pageStatus = healthStatusLabels[pageState];
  const pageStatusTone: BadgeProps["tone"] = disconnected
    ? "danger"
    : checking
      ? "muted"
      : degraded
        ? "warning"
        : "success";
  const refreshing = gateway.isFetching || readiness.isFetching || routing.isFetching || balancer.isFetching;

  const [confirming, setConfirming] = useState<
    | {
        kind: "breaker" | "sessions";
        provider: string;
        label: string;
        owner: FeatureReadOwner;
        snapshot: unknown;
        range: string;
      }
    | undefined
  >();
  const actionReturnFocusRef = useRef<HTMLElement | null>(null);
  const rememberActionTrigger = (): void => {
    actionReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };

  const breakerActions: BreakerActions = {
    canWrite: canWriteRouting && Boolean(routing.data) && !routing.isError && !routing.isFetching,
    deniedReason: routingWriteDeniedReason,
    pending: resetPending,
    onReset: (provider, label) => {
      if (!canWriteRouting) return;
      rememberActionTrigger();
      setConfirming({ kind: "breaker", provider, label, owner, snapshot: routing.data, range });
    },
  };

  const refreshAll = (): void => {
    void Promise.all([gateway.refetch(), readiness.refetch(), routing.refetch(), balancer.refetch()]);
  };

  const reviewed = confirming?.kind === "sessions" ? balancer : routing;
  const reviewCurrent =
    confirming?.owner === owner &&
    confirming.range === range &&
    owner.isCurrent() &&
    Boolean(reviewed.data) &&
    reviewed.data === confirming.snapshot &&
    !reviewed.isError &&
    !reviewed.isFetching;

  return (
    <div className="page-stack gateway-health-workspace">
      <header className="page-header">
        <div>
          <MigrationEyebrow />
          <h1>게이트웨이 상태</h1>
          <p>게이트웨이 연결, 요청 준비 상태와 공급자 라우팅 상태를 안전하게 조회합니다.</p>
        </div>
        <div className="page-actions">
          {!canWriteRouting ? (
            <Badge tone="info">{runtimeReadonly ? uiLabels.readOnly : "조작 권한 없음"}</Badge>
          ) : null}
          <Badge tone={pageStatusTone}>{pageStatus}</Badge>
          {showLegacyAdmin ? (
            <FeatureLegacyLink
              featureId="gateway.health"
              className="button button-secondary button-default"
              href={legacyRoutes.routingHealth}
            >
              기존 상태 화면 열기 <ExternalLink aria-hidden="true" />
            </FeatureLegacyLink>
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
          description="게이트웨이 프로세스 응답"
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
          description="요청 처리에 필요한 의존성 준비"
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

      {!owner.readable || owner.denied ? (
        <InlineNotice
          tone="warning"
          title="라우팅 상태 조회 권한을 확인하세요."
          actions={owner.readable ? <Button onClick={owner.restart}>권한 다시 확인</Button> : undefined}
        >
          routing:read 권한과 현재 계정의 기능 사용 범위를 확인하세요. 기존 공급자 정보와 복구 확인은
          폐기했습니다.
        </InlineNotice>
      ) : (
        <>
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
            title="요청 분배 · 세션 고정"
            description="공급자 분배 방식과 대화 연결 유지 상태"
            icon={Unplug}
            loading={balancer.isPending}
            error={balancer.error}
            onRetry={() => void balancer.refetch()}
            updatedAt={balancer.dataUpdatedAt || undefined}
          >
            {balancer.data ? (
              <div className="page-stack">
                <KeyValueList
                  items={[
                    {
                      label: "분배 방식",
                      value:
                        balancer.data.mode === "first"
                          ? "첫 공급자 우선"
                          : balancer.data.mode === "round_robin"
                            ? "순환 분배"
                            : balancer.data.mode === "session_hash"
                              ? "세션 해시 분배"
                              : "확인 필요",
                    },
                    {
                      label: "다중 인스턴스 안전",
                      value: balancer.data.multi_instance_safe ? "예" : "아니오",
                    },
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
                  disabled={!canWriteRouting || sessionsPending || balancer.isError || balancer.isFetching}
                  title={routingWriteDeniedReason}
                  onClick={() => {
                    if (!canWriteRouting) return;
                    rememberActionTrigger();
                    setConfirming({
                      kind: "sessions",
                      provider: "",
                      label: "전체 공급자",
                      owner,
                      snapshot: balancer.data,
                      range,
                    });
                  }}
                >
                  세션 고정 전체 해제
                </Button>
              </div>
            ) : null}
          </HealthWidget>
        </>
      )}
      <ConfirmDialog
        key={owner.id}
        confirmDisabled={!canWriteRouting || !reviewCurrent}
        open={confirming !== undefined && confirming.owner === owner && owner.readable && !owner.denied}
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
          if (!confirming || !reviewCurrent || !confirming.owner.isCurrent()) return;
          access.assertCurrent();
          if (confirming.kind === "sessions")
            await releaseSessions.mutateAsync({
              provider: confirming.provider,
              owner: confirming.owner,
              snapshotCurrent: () =>
                confirming.range === range && isSnapshotCurrent(confirming.kind, confirming.snapshot),
            });
          else
            await resetBreaker.mutateAsync({
              provider: confirming.provider,
              owner: confirming.owner,
              snapshotCurrent: () =>
                confirming.range === range && isSnapshotCurrent(confirming.kind, confirming.snapshot),
            });
          setConfirming(undefined);
        }}
      >
        {!canWriteRouting ? <InlineNotice tone="warning">{routingWriteDeniedReason}</InlineNotice> : null}
        {!reviewCurrent ? (
          <InlineNotice tone="warning">
            조회 상태가 변경되었거나 갱신 중입니다. 최신 상태를 확인한 뒤 작업을 다시 열어 주세요.
          </InlineNotice>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
