import { useQuery } from "@tanstack/react-query";
import { BudgetManagementLink } from "./BudgetManagementLink";
import { ErrorState, LoadingState, PermissionDenied } from "@/shared/components/state/PageStates";
import {
  assertFeatureRead,
  featureOwnedKey,
  useFeatureReadOwner,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";

import {
  costWindowFrom,
  budgetSeverityLabel,
  dimensionLabels,
  finopsAnomaliesQueryKey,
  finopsBudgetAlertsQueryKey,
  severityTone,
} from "@/features/finops/overview/finops-shared";
import { CostQueryFailure } from "@/features/finops/overview/finops-ui";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime, formatKRW, formatNumber, formatPercent, shortId } from "@/shared/utils/format";

export function BudgetTab(): React.JSX.Element {
  const owner = useFeatureReadOwner("finops.overview", "finops-budget", ["costs:read"]);
  if (!owner.readable) return <PermissionDenied permission="admin:read" />;
  if (owner.denied)
    return (
      <ErrorState
        title="예산 조회 권한을 다시 확인하세요."
        message="이전 예산·비용 조회 결과를 표시하지 않습니다."
        onRetry={owner.restart}
        showLegacy={false}
      />
    );
  return <BudgetContent key={owner.id} owner={owner} />;
}

function BudgetContent({ owner }: { owner: FeatureReadOwner }): React.JSX.Element {
  const [searchParams, updateSearch] = useSearchState();
  const window = costWindowFrom(searchParams.get("window"));

  const anomalies = useQuery({
    queryKey: featureOwnedKey([...finopsAnomaliesQueryKey, window], owner),
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const result = await apiClient.request(endpoints.domains.finops.costAnomalies, {
        query: { window, limit: 50 },
        signal,
        routeId: "finops.overview",
      });
      assertFeatureRead(owner, signal);
      return result;
    },
  });
  const alerts = useQuery({
    queryKey: featureOwnedKey(finopsBudgetAlertsQueryKey, owner),
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const result = await apiClient.request(endpoints.domains.finops.budgetAlerts, {
        // `all=1` returns every budget; `notify=1` would send Mattermost messages
        // and is deliberately never sent from the console.
        query: { all: 1 },
        signal,
        routeId: "finops.overview",
      });
      assertFeatureRead(owner, signal);
      return result;
    },
  });

  const projections = anomalies.data?.budget_projections ?? [];
  const overProjected = anomalies.data?.over_projected ?? [];
  const loops = anomalies.data?.session_loops ?? [];
  const alertRows = alerts.data?.alerts ?? [];
  const unavailable = anomalies.isPending || (anomalies.isError && !anomalies.data);

  return (
    <div className="finops-panel-stack">
      <BudgetManagementLink />
      <Toolbar label="비용 이상 조회 조건">
        <label className="form-field">
          <span>반복 호출 조회 기간</span>
          <select
            className="input select"
            value={window}
            onChange={(event) => updateSearch({ window: event.target.value })}
          >
            <option value="24h">최근 24시간</option>
            <option value="7d">최근 7일</option>
            <option value="30d">최근 30일</option>
          </select>
        </label>
        <span className="finops-meta">예산 소진 예측과 경고는 이번 달 기준입니다.</span>
      </Toolbar>

      {anomalies.isError ? (
        <CostQueryFailure
          error={anomalies.error}
          hasData={Boolean(anomalies.data)}
          label="예산 소진 예측"
          onRetry={() => void anomalies.refetch()}
        />
      ) : null}

      <StatGrid label="예산 요약">
        <StatCard label="예산 항목" value={unavailable ? "—" : formatNumber(projections.length)} />
        <StatCard
          label="초과 예상"
          tone={unavailable ? "default" : overProjected.length > 0 ? "danger" : "success"}
          value={unavailable ? "—" : formatNumber(overProjected.length)}
        />
        <StatCard
          label="경고·위험 예산"
          tone={
            (alerts.data?.critical ?? 0) > 0 ? "danger" : (alerts.data?.warn ?? 0) > 0 ? "warning" : "default"
          }
          value={alerts.data ? formatNumber(alerts.data.warn + alerts.data.critical) : "—"}
        />
        <StatCard
          label="반복 호출 세션"
          tone={loops.length > 0 ? "warning" : "default"}
          value={unavailable ? "—" : formatNumber(loops.length)}
        />
      </StatGrid>

      <SectionCard
        title="예산 소진 예측"
        description="현재 사용 추세를 이번 달 말까지 연장해 초과 여부를 계산합니다."
      >
        {anomalies.dataUpdatedAt > 0 ? (
          <p className="finops-meta">마지막 정상 조회 {formatDateTime(anomalies.dataUpdatedAt)}</p>
        ) : null}
        {anomalies.isPending ? (
          <LoadingState label="예산 소진 예측을 불러오는 중입니다." />
        ) : !anomalies.data ? null : projections.length === 0 ? (
          <EmptyState
            title="예산이 없습니다."
            description="사용자·팀 화면에서 월 예산을 등록하면 소진 예측이 계산됩니다."
          />
        ) : (
          <ul className="finops-list">
            {projections.map((status, index) => (
              <li key={status.budget?.id || index}>
                <Badge tone={status.on_track ? "success" : "danger"}>
                  {status.on_track ? "정상" : "초과 예상"}
                </Badge>
                <strong>
                  {dimensionLabels[status.budget?.scope ?? ""] ?? status.budget?.scope}
                  {status.budget?.scope_value ? ` · ${status.budget.scope_value}` : ""}
                </strong>
                <span className="finops-meta">
                  사용 {formatKRW(status.spent_krw)} / 예산 {formatKRW(status.budget?.monthly_krw)} (
                  {formatPercent(status.burn_ratio)}) · 월말 예상 {formatKRW(status.projected_krw)} (
                  {formatPercent(status.projected_ratio)}) · {formatNumber(status.days_elapsed, 1)}/
                  {formatNumber(status.days_in_month, 0)}일 경과
                  {status.exhaustion_date ? ` · 소진 예상 ${status.exhaustion_date}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="예산 경고"
        description="등록된 예산의 사용량과 경고 단계입니다. 이 조회는 알림을 발송하지 않습니다."
      >
        {alerts.dataUpdatedAt > 0 ? (
          <p className="finops-meta">마지막 정상 조회 {formatDateTime(alerts.dataUpdatedAt)}</p>
        ) : null}
        {alerts.isError ? (
          <CostQueryFailure
            error={alerts.error}
            hasData={Boolean(alerts.data)}
            label="예산 경고"
            onRetry={() => void alerts.refetch()}
          />
        ) : null}
        {alerts.isPending ? (
          <LoadingState label="예산 경고를 불러오는 중입니다." />
        ) : !alerts.data ? null : alertRows.length === 0 ? (
          <EmptyState title="예산 경고 항목이 없습니다." description="등록된 예산의 경고 항목이 없습니다." />
        ) : (
          <ul className="finops-list">
            {alertRows.map((alert, index) => (
              <li key={`${alert.scope}-${alert.scope_value}-${index}`}>
                <Badge tone={severityTone(alert.severity)}>{budgetSeverityLabel(alert.severity)}</Badge>
                <strong>
                  {dimensionLabels[alert.scope] ?? alert.scope}
                  {alert.scope_value ? ` · ${alert.scope_value}` : ""}
                </strong>
                <span className="finops-meta">
                  사용 {formatKRW(alert.spent_krw)} / {formatKRW(alert.monthly_krw)} (
                  {formatPercent(alert.burn_ratio)}) · 월말 예상 {formatKRW(alert.projected_krw)}
                  {alert.exhaustion_date ? ` · 소진 예상 ${alert.exhaustion_date}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="반복 호출 비용 이상"
        description="같은 프롬프트를 반복하는 세션은 에이전트 루프일 수 있어 비용이 빠르게 늘어납니다."
      >
        {anomalies.isPending ? (
          <LoadingState label="반복 호출 비용 이상을 불러오는 중입니다." />
        ) : !anomalies.data ? null : loops.length === 0 ? (
          <EmptyState title="반복 호출이 없습니다." description="선택 기간에 의심 세션이 없습니다." />
        ) : (
          <ul className="finops-list">
            {loops.map((loop, index) => (
              <li key={`${loop.session_id}-${index}`}>
                <Badge tone="warning">{formatNumber(loop.repeats)}회 반복</Badge>
                <strong className="mono">{shortId(loop.session_id)}</strong>
                <span className="finops-meta">
                  비용 {formatKRW(loop.cost_krw)} · 토큰 {formatNumber(loop.tokens)} · API 키{" "}
                  {shortId(loop.api_key_id)} · {formatDateTime(loop.first_seen)} ~{" "}
                  {formatDateTime(loop.last_seen)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
