import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { Link } from "react-router";

import {
  costWindowFrom,
  dimensionLabels,
  finopsAnomaliesQueryKey,
  finopsBudgetAlertsQueryKey,
  severityTone,
} from "@/features/finops/overview/finops-shared";
import { CostQueryFailure, LegacyHint } from "@/features/finops/overview/finops-ui";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime, formatKRW, formatNumber, formatPercent, shortId } from "@/shared/utils/format";

export function BudgetTab(): React.JSX.Element {
  const [searchParams] = useSearchState();
  const window = costWindowFrom(searchParams.get("window"));

  const anomalies = useQuery({
    queryKey: [...finopsAnomaliesQueryKey, window],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.finops.costAnomalies, {
        query: { window, limit: 50 },
        signal,
        routeId: "finops.overview",
      }),
  });
  const alerts = useQuery({
    queryKey: finopsBudgetAlertsQueryKey,
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.finops.budgetAlerts, {
        // `all=1` returns every budget; `notify=1` would send Mattermost messages
        // and is deliberately never sent from the console.
        query: { all: 1 },
        signal,
        routeId: "finops.overview",
      }),
  });

  const projections = anomalies.data?.budget_projections ?? [];
  const overProjected = anomalies.data?.over_projected ?? [];
  const loops = anomalies.data?.session_loops ?? [];
  const alertRows = alerts.data?.alerts ?? [];
  const unavailable = anomalies.isPending || (anomalies.isError && !anomalies.data);

  return (
    <div className="finops-panel-stack">
      <LegacyHint>
        예산 등록·수정·삭제는 <Link to="/access/users">사용자·팀</Link> 화면에서 합니다. 이 탭은 소진 예측과
        비용 이상 신호만 보여 줍니다.{" "}
        <a href="/admin#/users/quotas">
          기존 화면에서 열기 <ExternalLink aria-hidden="true" />
        </a>
      </LegacyHint>

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
          tone={overProjected.length > 0 ? "danger" : "success"}
          value={unavailable ? "—" : formatNumber(overProjected.length)}
        />
        <StatCard
          label="경고 임계 초과"
          tone={(alerts.data?.warn ?? 0) > 0 ? "warning" : "default"}
          value={alerts.isPending ? "—" : formatNumber(alerts.data?.warn)}
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
        {projections.length === 0 ? (
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

      <SectionCard title="예산 경고" description="경고·위험 임계값을 넘긴 예산입니다.">
        {alerts.isError ? (
          <CostQueryFailure
            error={alerts.error}
            hasData={Boolean(alerts.data)}
            label="예산 경고"
            onRetry={() => void alerts.refetch()}
          />
        ) : alertRows.length === 0 ? (
          <EmptyState title="경고가 없습니다." description="임계값을 넘긴 예산이 없습니다." />
        ) : (
          <ul className="finops-list">
            {alertRows.map((alert, index) => (
              <li key={`${alert.scope}-${alert.scope_value}-${index}`}>
                <Badge tone={severityTone(alert.severity)}>{alert.severity}</Badge>
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
        {loops.length === 0 ? (
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
