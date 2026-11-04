import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatSignedRatio, severityTone } from "@/features/access/access-format";
import { QueryNotice, UpdatedAt } from "@/features/access/access-ui";
import { BudgetNotificationAction } from "./BudgetNotificationAction";
import { QuotaBudgetDialogs } from "./QuotaBudgetDialogs";
import { QuotaUsageTable, BudgetUsageTable } from "./QuotaBudgetTables";
import { useQuotaBudgetOperations, scopeLabels } from "./use-quota-budget-operations";
import { accessKeys, useBudgetProjectionQuery, useBudgetsQuery, useQuotasQuery } from "./use-access-admin";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import {
  assertFeatureRead,
  featureOwnedKey,
  useFeatureReadOwner,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { LoadingState, PermissionDenied, ErrorState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { formatDate, formatKRW, formatNumber } from "@/shared/utils/format";
const access = endpoints.domains.access;
const routeId = "access.users";
interface QuotasTabProps {
  canWrite: boolean;
  writeDeniedReason: string;
}

export function QuotasTab(props: QuotasTabProps): React.JSX.Element {
  const owner = useFeatureReadOwner(routeId, "quota-budget-administration");
  if (!owner.readable) return <PermissionDenied permission="admin:read" />;
  if (owner.denied)
    return (
      <ErrorState
        title="할당량·예산 조회 권한을 다시 확인하세요."
        message="이전 조회 결과와 열린 작업을 표시하지 않습니다."
        onRetry={owner.restart}
        legacyHref="/admin#/users"
      />
    );
  return <QuotaBudgetContent key={owner.id} {...props} owner={owner} />;
}
function QuotaBudgetContent({
  canWrite,
  writeDeniedReason,
  owner,
}: QuotasTabProps & { owner: FeatureReadOwner }) {
  const quotas = useQuotasQuery(true, owner);
  const budgets = useBudgetsQuery(true, owner);
  const projection = useBudgetProjectionQuery(true, owner);
  const [alertsRequested, setAlertsRequested] = useState(false);
  const alerts = useQuery({
    queryKey: featureOwnedKey([...accessKeys.budgetAlerts, "check"], owner),
    gcTime: 0,
    retry: false,
    enabled: alertsRequested,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const result = await apiClient.request(access.budgets.alerts, { query: { all: 1 }, signal, routeId });
      assertFeatureRead(owner, signal);
      return result;
    },
  });

  const operations = useQuotaBudgetOperations(owner, canWrite, writeDeniedReason);
  const { quotaTrigger, budgetTrigger, quotaForm, budgetForm, setQuotaOpen, setBudgetOpen } = operations;
  const allowed = operations.write.allowed;
  const deniedReason = operations.write.reason ?? writeDeniedReason;
  if (quotas.isPending && !quotas.data) {
    return <LoadingState label="할당량과 예산을 불러오는 중입니다." />;
  }

  const usage = quotas.data?.usage ?? [];
  const budgetRows = budgets.data?.budgets ?? [];
  const projectionRows = projection.data?.teams ?? [];
  const overBudget = budgetRows.filter((row) => !row.on_track).length;

  return (
    <div className="access-stack">
      {quotas.isError ? (
        <QueryNotice
          error={quotas.error}
          hasData={Boolean(quotas.data)}
          label="할당량"
          onRetry={() => void quotas.refetch()}
        />
      ) : null}
      {budgets.isError ? (
        <QueryNotice
          error={budgets.error}
          hasData={Boolean(budgets.data)}
          label="예산"
          onRetry={() => void budgets.refetch()}
        />
      ) : null}

      <StatGrid label="할당량과 예산 요약">
        <StatCard label="할당량" value={quotas.data ? formatNumber(usage.length) : "—"} />
        <StatCard
          label="사용 중지된 할당량"
          value={quotas.data ? formatNumber(usage.filter((row) => !row.quota.enabled).length) : "—"}
        />
        <StatCard label="예산" value={budgets.data ? formatNumber(budgetRows.length) : "—"} />
        <StatCard
          label="예상 초과 예산"
          tone={overBudget > 0 ? "danger" : "default"}
          value={budgets.data ? formatNumber(overBudget) : "—"}
        />
      </StatGrid>

      <SectionCard
        title="할당량"
        description="범위별 토큰·비용 한도와 현재 사용량입니다. 한도가 설정되지 않은 항목은 대시로 표시합니다."
        actions={
          <Button
            ref={quotaTrigger}
            variant="primary"
            disabled={!allowed}
            title={deniedReason}
            onClick={() => {
              quotaForm.reset({
                scope: "team",
                scope_value: "",
                period: "monthly",
                token_limit: "",
                krw_limit: "",
                note: "",
              });
              setQuotaOpen(true);
            }}
          >
            할당량 추가
          </Button>
        }
      >
        {!allowed ? <InlineNotice tone="info">{deniedReason}</InlineNotice> : null}
        {!quotas.data ? (
          <p className="access-note">할당량 데이터를 확인할 수 없습니다.</p>
        ) : usage.length === 0 ? (
          <EmptyState
            title="설정된 할당량이 없습니다."
            description="'할당량 추가'로 팀이나 키의 토큰·비용 한도를 정하면 사용량이 여기에 표시됩니다."
          />
        ) : (
          <QuotaUsageTable usage={usage} operations={operations} />
        )}
        <UpdatedAt at={quotas.dataUpdatedAt} />
      </SectionCard>

      <SectionCard
        title="월 예산"
        description="월 예산 대비 소진율과 이번 달 예상 지출입니다."
        actions={
          <Button
            ref={budgetTrigger}
            variant="primary"
            disabled={!allowed}
            title={deniedReason}
            onClick={() => {
              budgetForm.reset({ scope: "team", scope_value: "", monthly_krw: "", note: "" });
              setBudgetOpen(true);
            }}
          >
            예산 추가
          </Button>
        }
      >
        {budgets.isPending && !budgets.data ? (
          <LoadingState label="예산을 불러오는 중입니다." />
        ) : !budgets.data ? (
          <p className="access-note">예산 데이터를 확인할 수 없습니다.</p>
        ) : budgetRows.length === 0 ? (
          <EmptyState
            title="설정된 예산이 없습니다."
            description="'예산 추가'로 팀이나 키의 월 예산을 정하면 소진율과 예상 지출이 표시됩니다."
          />
        ) : (
          <BudgetUsageTable budgetRows={budgetRows} operations={operations} />
        )}
        <UpdatedAt at={budgets.dataUpdatedAt} />
      </SectionCard>

      <SectionCard
        title="팀별 월말 예상 지출"
        description="이번 달 사용 속도로 계산한 팀별 월말 예상 지출과 팀 예산 초과 여부입니다."
      >
        {projection.isError ? (
          <QueryNotice
            error={projection.error}
            hasData={Boolean(projection.data)}
            label="지출 예측"
            onRetry={() => void projection.refetch()}
          />
        ) : null}
        {projection.isPending && !projection.data ? (
          <LoadingState label="지출 예측을 불러오는 중입니다." />
        ) : !projection.data ? null : projectionRows.length === 0 ? (
          <EmptyState
            title="예측할 팀 사용량이 없습니다."
            description="이번 달에 요청을 보낸 팀이 생기면 월말 예상 지출을 계산합니다."
          />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="팀별 월말 예상 지출 표 영역">
            <table className="data-table">
              <caption className="sr-only">팀별 월말 예상 지출</caption>
              <thead>
                <tr>
                  {["팀", "이번 달 지출", "월말 예상", "팀 예산", "예상 초과액", "경과일"].map((label) => (
                    <th key={label} scope="col">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {projectionRows.map((row) => (
                  <tr key={row.team} className={row.will_exceed ? "row-danger" : undefined}>
                    <td className="truncate">
                      {row.team || "—"}
                      {row.will_exceed ? <Badge tone="danger">초과 예상</Badge> : null}
                    </td>
                    <td className="cell-number">{formatKRW(row.spent_krw)}</td>
                    <td className="cell-number">{formatKRW(row.projected_krw)}</td>
                    <td className="cell-number">{row.has_budget ? formatKRW(row.budget_krw) : "미설정"}</td>
                    <td className="cell-number">
                      {row.projected_overage_krw > 0 ? formatKRW(row.projected_overage_krw) : "—"}
                    </td>
                    <td className="cell-number">
                      {formatNumber(row.days_elapsed, 1)} / {formatNumber(row.days_in_month, 1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {projection.data ? (
          <p className="access-note">
            예상 초과 팀 {formatNumber(projection.data?.exceeding ?? 0)}곳입니다. 팀 예산이 없는 팀은 초과
            여부를 계산하지 않습니다.
          </p>
        ) : null}
        <UpdatedAt at={projection.dataUpdatedAt} />
      </SectionCard>

      <SectionCard
        title="예산 경보"
        description="경보를 확인해도 알림은 발송되지 않습니다. 발송은 별도 버튼으로만 실행합니다."
        actions={
          <div className="access-inline-actions">
            <Button
              onClick={() => {
                if (alertsRequested) void alerts.refetch();
                else setAlertsRequested(true);
              }}
              disabled={alerts.isFetching}
            >
              {alerts.isFetching ? "확인 중" : "경보 확인"}
            </Button>
            <BudgetNotificationAction canWrite={canWrite} writeDeniedReason={writeDeniedReason} />
          </div>
        }
      >
        {!alertsRequested ? (
          <p className="access-note">
            '경보 확인'을 누르면 현재 예산 경보 목록을 조회합니다. 조회만으로는 알림이 나가지 않습니다.
          </p>
        ) : alerts.isPending && !alerts.data ? (
          <LoadingState label="예산 경보를 불러오는 중입니다." />
        ) : alerts.isError ? (
          <QueryNotice
            error={alerts.error}
            hasData={Boolean(alerts.data)}
            label="예산 경보"
            onRetry={() => void alerts.refetch()}
          />
        ) : alerts.data && alerts.data.alerts.length === 0 ? (
          <EmptyState
            title="경보가 없습니다."
            description="설정된 예산이 임계값을 넘으면 이 목록에 나타납니다."
          />
        ) : alerts.data ? (
          <ul className="access-list">
            {alerts.data.alerts.map((row, index) => (
              <li key={`${row.scope}-${row.scope_value}-${String(index)}`}>
                <span className="access-list-title">
                  <Badge tone={severityTone(row.severity)}>{row.severity || "정보"}</Badge>
                  {scopeLabels[row.scope] ?? row.scope} · {row.scope_value || "*"}
                </span>
                <span className="access-list-detail">
                  {formatKRW(row.spent_krw)} / {formatKRW(row.monthly_krw)} · 소진율{" "}
                  {formatSignedRatio(row.burn_ratio)} · 예상 {formatKRW(row.projected_krw)}
                  {row.exhaustion_date ? ` · 소진 예상 ${formatDate(row.exhaustion_date)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </SectionCard>

      <QuotaBudgetDialogs operations={operations} />
    </div>
  );
}
