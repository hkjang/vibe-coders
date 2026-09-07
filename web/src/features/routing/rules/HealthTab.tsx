import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useRef, useState } from "react";

import {
  routingBalancerQueryKey,
  routingHealthQueryKey,
  scoreTone,
  severityTone,
  writeScopeMessage,
} from "@/features/routing/rules/routing-shared";
import { BarList, QueryFailureNotice, ScopeNotice } from "@/features/routing/rules/routing-ui";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime, formatDuration, formatNumber, formatPercent } from "@/shared/utils/format";

const windows = ["1h", "6h", "24h", "7d", "30d"] as const;
const defaultWindow = "24h";
const defaultThreshold = 70;

function windowFrom(value: string | null): string {
  return (windows as readonly string[]).includes(value ?? "") ? (value as string) : defaultWindow;
}

function thresholdFrom(value: string | null): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : defaultThreshold;
}

export function HealthTab({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const [searchParams, updateSearch] = useSearchState();
  const window = windowFrom(searchParams.get("window"));
  const threshold = thresholdFrom(searchParams.get("threshold"));
  const refreshInterval = useRefreshInterval();
  const [breakerTarget, setBreakerTarget] = useState<{ provider: string; label: string }>();
  const [stickyTarget, setStickyTarget] = useState<{ provider: string; label: string }>();
  const breakerTrigger = useRef<HTMLButtonElement>(null);
  const stickyTrigger = useRef<HTMLButtonElement>(null);

  const health = useQuery({
    queryKey: [...routingHealthQueryKey, window, threshold],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.routing.health, {
        query: { window, threshold },
        signal,
        routeId: "routing.rules",
      }),
    refetchInterval: refreshInterval,
  });
  const balancer = useQuery({
    queryKey: [...routingBalancerQueryKey, window],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.routing.balancer.read, {
        query: { window },
        signal,
        routeId: "routing.rules",
      }),
    refetchInterval: refreshInterval,
  });

  const resetBreaker = useMutationFeedback<string, unknown>({
    mutate: (provider) => apiClient.request(endpoints.domains.routing.breakerReset, { body: { provider } }),
    invalidates: [routingHealthQueryKey],
    successMessage: "회로 차단기를 해제했습니다.",
    errorMessage: "회로 차단기를 해제하지 못했습니다.",
  });
  const releaseSticky = useMutationFeedback<string, unknown>({
    mutate: (provider) =>
      apiClient.request(endpoints.domains.routing.balancer.release, { body: { provider } }),
    invalidates: [routingBalancerQueryKey],
    successMessage: "세션 고정을 해제했습니다.",
    errorMessage: "세션 고정을 해제하지 못했습니다.",
  });

  const providers = health.data?.providers ?? [];
  const ranking = health.data?.ranking ?? [];
  const degraded = health.data?.degraded ?? [];
  const alerts = health.data?.alerts ?? [];
  const breakers = health.data?.breakers;
  const averageScore =
    providers.length > 0
      ? Math.round(providers.reduce((total, item) => total + item.score, 0) / providers.length)
      : undefined;
  const unavailable = health.isPending || (health.isError && !health.data);

  return (
    <div className="routing-panel-stack">
      {canWrite ? null : <ScopeNotice>{writeScopeMessage}</ScopeNotice>}

      <Toolbar
        label="공급자 상태 조회 조건"
        end={
          <Button
            onClick={() => {
              void health.refetch();
              void balancer.refetch();
            }}
            disabled={health.isFetching || balancer.isFetching}
          >
            <RefreshCw aria-hidden="true" /> {health.isFetching ? "갱신 중" : "새로고침"}
          </Button>
        }
      >
        <label className="form-field">
          <span>조회 기간</span>
          <select
            className="input select"
            value={window}
            onChange={(event) => updateSearch({ window: event.target.value })}
          >
            {windows.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span>저하 판단 점수</span>
          <input
            className="input"
            type="number"
            min={0}
            max={100}
            value={threshold}
            onChange={(event) => updateSearch({ threshold: event.target.value })}
          />
        </label>
      </Toolbar>

      {health.isError ? (
        <QueryFailureNotice
          error={health.error}
          hasData={Boolean(health.data)}
          label="공급자 상태"
          onRetry={() => void health.refetch()}
        />
      ) : null}

      <StatGrid label="공급자 상태 요약">
        <StatCard label="공급자" value={unavailable ? "—" : formatNumber(providers.length)} />
        <StatCard label="평균 상태 점수" value={unavailable ? "—" : formatNumber(averageScore)} />
        <StatCard
          label="최상위 공급자"
          value={unavailable ? "—" : (ranking[0]?.provider ?? "—")}
          hint={ranking[0] ? `점수 ${formatNumber(ranking[0].score)}` : undefined}
        />
        <StatCard
          label="저하 공급자"
          tone={degraded.length > 0 ? "warning" : "default"}
          value={unavailable ? "—" : formatNumber(degraded.length)}
        />
      </StatGrid>

      <SectionCard
        title="공급자 상태 점수"
        description={`조회 구간 ${formatDateTime(health.data?.since)} 이후`}
      >
        {providers.length === 0 ? (
          <EmptyState
            title="상태 점수가 없습니다."
            description="선택한 기간에 처리된 요청이 있어야 공급자 상태 점수가 계산됩니다."
          />
        ) : (
          <BarList
            label="공급자 상태 점수"
            items={ranking.map((item) => ({
              label: item.provider,
              value: item.score,
              display: `${formatNumber(item.score)} · 요청 ${formatNumber(item.requests)} · 폴백 ${formatPercent(item.fallback_rate)}`,
              tone: scoreTone(item.score, threshold),
            }))}
          />
        )}
      </SectionCard>

      <SectionCard title="상태 경고" description="선택 기간에 감지된 공급자 신호입니다.">
        {alerts.length === 0 ? (
          <EmptyState title="경고가 없습니다." description="임계값을 넘긴 공급자 신호가 없습니다." />
        ) : (
          <ul className="routing-steps">
            {alerts.map((alert, index) => (
              <li key={`${alert.provider}-${alert.code}-${index}`}>
                <Badge tone={severityTone(alert.severity)}>{alert.severity}</Badge>
                <strong>{alert.provider}</strong>
                <span>{alert.message}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="회로 차단기"
        description="상태 점수와 달리 지금 폴백 대상에서 제외 중인 공급자를 보여 줍니다."
        actions={
          <Button
            ref={breakerTrigger}
            disabled={!canWrite}
            title={canWrite ? undefined : writeScopeMessage}
            onClick={() => setBreakerTarget({ provider: "", label: "모든 공급자" })}
          >
            전체 해제
          </Button>
        }
      >
        <KeyValueList
          items={[
            { label: "차단기 사용", value: breakers?.enabled ? "사용" : "미사용" },
            { label: "실패 임계값", value: formatNumber(breakers?.threshold) },
            { label: "쿨다운", value: formatDuration((breakers?.cooldown_seconds ?? 0) * 1000) },
            { label: "상태 공유", value: breakers?.shared ? "여러 인스턴스 공유" : "이 인스턴스 전용" },
          ]}
        />
        {(breakers?.states.length ?? 0) === 0 ? (
          <EmptyState
            title="차단된 공급자가 없습니다."
            description="공급자 호출이 연속으로 실패하면 이 목록에 나타납니다."
          />
        ) : (
          <ul className="routing-steps">
            {(breakers?.states ?? []).map((state) => (
              <li key={`${state.provider}-${state.provider_ref}`}>
                <Badge
                  tone={state.phase === "open" ? "danger" : state.phase === "half_open" ? "warning" : "muted"}
                >
                  {state.phase}
                </Badge>
                <strong>{state.provider}</strong>
                <span className="routing-meta">
                  실패 {formatNumber(state.failures)}회 · 개방 {formatNumber(state.opens)}회
                  {state.retry_in_seconds > 0 ? ` · ${formatNumber(state.retry_in_seconds)}초 후 재시도` : ""}
                  {state.last_reason ? ` · ${state.last_reason}` : ""}
                </span>
                <Button
                  size="small"
                  aria-label={`${state.provider} 회로 차단기 해제`}
                  disabled={!canWrite}
                  title={canWrite ? undefined : writeScopeMessage}
                  onClick={(event) => {
                    breakerTrigger.current = event.currentTarget;
                    setBreakerTarget({ provider: state.provider, label: state.provider });
                  }}
                >
                  해제
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="로드밸런싱·세션 고정"
        description="분산 의도(intent)와 실제 처리량(actual)을 비교해 라운드로빈이 실제로 동작했는지 확인합니다."
        actions={
          <Button
            ref={stickyTrigger}
            disabled={!canWrite}
            title={canWrite ? undefined : writeScopeMessage}
            onClick={() => setStickyTarget({ provider: "", label: "모든 공급자" })}
          >
            세션 고정 전체 해제
          </Button>
        }
      >
        {balancer.isError ? (
          <QueryFailureNotice
            error={balancer.error}
            hasData={Boolean(balancer.data)}
            label="로드밸런싱 상태"
            onRetry={() => void balancer.refetch()}
          />
        ) : null}
        <KeyValueList
          items={[
            { label: "분산 방식", value: balancer.data?.mode },
            { label: "다중 인스턴스 안전", value: balancer.data?.multi_instance_safe ? "예" : "아니오" },
            { label: "세션 고정", value: balancer.data?.sticky_sessions ? "사용" : "미사용" },
            { label: "고정 TTL", value: balancer.data?.sticky_ttl },
            { label: "활성 고정 세션", value: formatNumber(balancer.data?.active_sessions) },
            { label: "균형 지수", value: formatPercent(balancer.data?.balance_index) },
          ]}
        />
        {(balancer.data?.actual.length ?? 0) === 0 ? (
          <EmptyState
            title="분산 기록이 없습니다."
            description="선택 기간에 공급자로 나간 요청이 있어야 분산 결과가 표시됩니다."
          />
        ) : (
          <BarList
            label="공급자별 실제 처리량"
            items={(balancer.data?.actual ?? []).map((share) => ({
              label: share.provider,
              value: share.requests,
              display: `요청 ${formatNumber(share.requests)} · 폴백 ${formatNumber(share.failovers)} · 오류 ${formatNumber(share.errors)}`,
            }))}
          />
        )}
        {(balancer.data?.intent.length ?? 0) > 0 ? (
          <ul className="routing-steps">
            {(balancer.data?.intent ?? []).map((intent) => (
              <li key={intent.provider}>
                <strong>{intent.provider}</strong>
                <span className="routing-meta">
                  선택 {formatNumber(intent.picks)}회 · 점유 {formatPercent(intent.share)} · 고정 세션{" "}
                  {formatNumber(intent.sessions)}
                </span>
                <Button
                  size="small"
                  aria-label={`${intent.provider} 세션 고정 해제`}
                  disabled={!canWrite}
                  title={canWrite ? undefined : writeScopeMessage}
                  onClick={(event) => {
                    stickyTrigger.current = event.currentTarget;
                    setStickyTarget({ provider: intent.provider, label: intent.provider });
                  }}
                >
                  고정 해제
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {balancer.data && !balancer.data.multi_instance_safe ? (
          <InlineNotice tone="warning" title="다중 인스턴스 주의">
            현재 분산 방식은 게이트웨이 인스턴스마다 독립적으로 동작합니다. 여러 인스턴스를 운영하면 같은
            대화가 인스턴스별로 다른 공급자에 붙을 수 있습니다.
          </InlineNotice>
        ) : null}
      </SectionCard>

      <ConfirmDialog
        confirmLabel="해제"
        description={`${breakerTarget?.label ?? ""}의 회로 차단기를 즉시 해제합니다.`}
        onConfirm={async () => {
          if (breakerTarget) await resetBreaker.mutateAsync(breakerTarget.provider);
        }}
        onOpenChange={(open) => {
          if (!open) setBreakerTarget(undefined);
        }}
        open={breakerTarget !== undefined}
        returnFocusRef={breakerTrigger}
        title="회로 차단기 해제"
      >
        <p>해제하면 쿨다운을 기다리지 않고 곧바로 해당 공급자로 다시 요청이 나갑니다.</p>
      </ConfirmDialog>

      <ConfirmDialog
        confirmLabel="해제"
        description={`${stickyTarget?.label ?? ""}에 고정된 세션 연결을 끊습니다.`}
        onConfirm={async () => {
          if (stickyTarget) await releaseSticky.mutateAsync(stickyTarget.provider);
        }}
        onOpenChange={(open) => {
          if (!open) setStickyTarget(undefined);
        }}
        open={stickyTarget !== undefined}
        returnFocusRef={stickyTrigger}
        title="세션 고정 해제"
      >
        <p>해제 후 진행 중인 대화는 다음 요청부터 다른 공급자로 이동할 수 있습니다.</p>
      </ConfirmDialog>
    </div>
  );
}
