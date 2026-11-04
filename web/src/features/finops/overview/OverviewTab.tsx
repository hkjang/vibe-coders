import { FinopsReadBoundary } from "./FinopsReadBoundary";
import { useFinopsReadQuery } from "./use-finops-read-query";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { LoadingState } from "@/shared/components/state/PageStates";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { RefreshCw } from "lucide-react";

import {
  costWindowFrom,
  costWindows,
  costWindowLabels,
  dimensionLabels,
  finopsBillingQueryKey,
} from "@/features/finops/overview/finops-shared";
import { CostBars, CostQueryFailure } from "@/features/finops/overview/finops-ui";
import { apiClient } from "@/shared/api/client";
import type { BudgetStatusRow } from "@/shared/api/domains/finops";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime, formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";

function budgetTone(status: BudgetStatusRow): "danger" | "warning" | "default" {
  if (!status.on_track) return "danger";
  if (status.burn_ratio >= 0.8) return "warning";
  return "default";
}

export function OverviewTab(): React.JSX.Element {
  return (
    <FinopsReadBoundary scope="billing">{(owner) => <OverviewContent owner={owner} />}</FinopsReadBoundary>
  );
}
function OverviewContent({ owner }: { owner: FeatureReadOwner }): React.JSX.Element {
  const [searchParams, updateSearch] = useSearchState();
  const window = costWindowFrom(searchParams.get("window"));
  const refreshInterval = useRefreshInterval();

  const billing = useFinopsReadQuery(
    owner,
    [...finopsBillingQueryKey, window],
    (signal) =>
      apiClient.request(endpoints.domains.finops.billingDashboard, {
        query: { window },
        signal,
        routeId: "finops.overview",
      }),
    refreshInterval,
  );

  const unavailable = billing.isPending || (billing.isError && !billing.data);
  const failed = (section: "by_cost_center" | "by_model" | "budgets" | "migration_candidates") =>
    billing.data?.unavailable_sections?.includes(section) ?? false;
  const budgets = failed("budgets") ? [] : (billing.data?.budgets ?? []);
  const migrations = failed("migration_candidates") ? [] : (billing.data?.migration_candidates ?? []);
  const exactTotals = billing.data?.totals_scope === "all_retained_requests";
  const sectionFailure = (label: string) => (
    <InlineNotice
      tone="warning"
      title={`${label} 조회에 실패했습니다.`}
      actions={
        <Button size="small" disabled={billing.isFetching} onClick={() => void billing.refetch()}>
          다시 시도
        </Button>
      }
    >
      이 영역의 값은 확인되지 않았습니다. 다른 정상 조회 결과는 계속 표시합니다.
    </InlineNotice>
  );
  const column = createDataTableColumnHelper<(typeof migrations)[number]>();
  const migrationColumns: ReadonlyArray<DataTableColumn<(typeof migrations)[number]>> = column.columns([
    column.accessor((row) => row.task_type, { id: "task_type", header: "작업 유형" }),
    column.accessor((row) => row.current_model, {
      id: "current_model",
      header: "현재 모델",
      cell: ({ getValue }) => <span className="mono">{getValue() || "—"}</span>,
    }),
    column.accessor((row) => row.recommended_model, {
      id: "recommended_model",
      header: "전환 후보",
      cell: ({ getValue }) => <span className="mono">{getValue() || "—"}</span>,
    }),
    column.accessor((row) => row.requests, {
      id: "requests",
      header: "요청",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.current_success_rate, {
      id: "success",
      header: "성공률(현재 → 후보)",
      cell: ({ row, getValue }) => (
        <span className="cell-number">
          {formatPercent(getValue())} → {formatPercent(row.original.recommended_success_rate)}
        </span>
      ),
    }),
    column.accessor((row) => row.estimated_savings_krw, {
      id: "savings",
      header: "예상 절감",
      cell: ({ getValue }) => <span className="cell-number">{formatKRW(getValue())}</span>,
    }),
  ]);

  return (
    <div className="finops-panel-stack">
      <Toolbar
        label="비용 대시보드 조회 조건"
        end={
          <Button onClick={() => void billing.refetch()} disabled={billing.isFetching}>
            <RefreshCw aria-hidden="true" /> {billing.isFetching ? "갱신 중" : "새로고침"}
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
            {costWindows.map((item) => (
              <option key={item} value={item}>
                {costWindowLabels[item]}
              </option>
            ))}
          </select>
        </label>
        <span className="finops-meta" role="status">
          마지막 갱신 {billing.dataUpdatedAt ? formatDateTime(billing.dataUpdatedAt) : "—"}
        </span>
      </Toolbar>

      {billing.isError ? (
        <CostQueryFailure
          error={billing.error}
          hasData={Boolean(billing.data)}
          label="비용 대시보드"
          onRetry={() => void billing.refetch()}
        />
      ) : null}

      <StatGrid label="비용 요약">
        <StatCard
          label={billing.data && !exactTotals ? "상위 모델 비용 합계" : "총 비용"}
          value={unavailable ? "—" : formatKRW(billing.data?.total_cost_krw)}
        />
        <StatCard
          label={billing.data && !exactTotals ? "상위 모델 요청 합계" : "총 요청"}
          value={unavailable ? "—" : formatNumber(billing.data?.total_requests)}
        />
        <StatCard
          label="조회된 후보 예상 절감액"
          tone={
            !failed("migration_candidates") && (billing.data?.estimated_savings_krw ?? 0) > 0
              ? "success"
              : "default"
          }
          value={
            unavailable || failed("migration_candidates")
              ? "—"
              : formatKRW(billing.data?.estimated_savings_krw)
          }
        />
        <StatCard
          label="예산 항목"
          tone={budgets.some((budget) => !budget.on_track) ? "warning" : "default"}
          value={unavailable || failed("budgets") ? "—" : formatNumber(budgets.length)}
        />
      </StatGrid>
      {billing.data ? (
        <InlineNotice tone={exactTotals ? "info" : "warning"} title="집계 범위 안내">
          {exactTotals
            ? "총 비용·요청은 선택 기간에 보관 중인 전체 요청 기준입니다. 보존 기간이 지난 요청은 포함하지 않습니다."
            : "이전 서버의 합계는 상위 20개 모델 기준일 수 있어 전체 비용·요청으로 표시하지 않습니다. 전체 합계 확인에는 서버 업그레이드가 필요합니다."}
          {
            " 차트는 비용순 상위 20개이며, 각 항목은 별도 조회되어 동시에 유입된 요청 때문에 합계와 차이가 날 수 있습니다."
          }
        </InlineNotice>
      ) : null}

      <SectionCard
        title="비용센터별 비용"
        description={`${costWindowLabels[window]} 동안 비용순 상위 20개 비용센터입니다.`}
      >
        {billing.isPending ? (
          <LoadingState label="비용센터별 비용을 불러오는 중입니다." />
        ) : failed("by_cost_center") ? (
          sectionFailure("비용센터별 비용")
        ) : !billing.data ? null : billing.data.by_cost_center.length === 0 ? (
          <EmptyState
            title="비용센터별 비용이 없습니다."
            description="요청에 비용센터 메타데이터가 붙으면 이 목록이 채워집니다."
          />
        ) : (
          <CostBars
            label="비용센터별 비용"
            items={(billing.data?.by_cost_center ?? []).map((row) => ({
              label: row.key || "(미지정)",
              value: row.cost_krw,
              display: `${formatKRW(row.cost_krw)} · 요청 ${formatNumber(row.requests)}`,
            }))}
          />
        )}
      </SectionCard>

      <SectionCard
        title="모델별 비용"
        description={`${costWindowLabels[window]} 동안 비용순 상위 20개 모델입니다.`}
      >
        {billing.isPending ? (
          <LoadingState label="모델별 비용을 불러오는 중입니다." />
        ) : failed("by_model") ? (
          sectionFailure("모델별 비용")
        ) : !billing.data ? null : billing.data.by_model.length === 0 ? (
          <EmptyState title="모델별 비용이 없습니다." description="요청이 쌓이면 모델별 비용이 보입니다." />
        ) : (
          <CostBars
            label="모델별 비용"
            items={(billing.data?.by_model ?? []).map((row) => ({
              label: row.key || "(미지정)",
              value: row.cost_krw,
              display: `${formatKRW(row.cost_krw)} · 요청 ${formatNumber(row.requests)}`,
            }))}
          />
        )}
      </SectionCard>

      <SectionCard
        title="예산 소진율"
        description="선택한 조회 기간과 별개로 이번 달 예산 대비 사용액과 추세입니다."
      >
        {billing.isPending ? (
          <LoadingState label="예산 소진율을 불러오는 중입니다." />
        ) : failed("budgets") ? (
          sectionFailure("예산 소진율")
        ) : !billing.data ? null : budgets.length === 0 ? (
          <EmptyState
            title="등록된 예산이 없습니다."
            description="사용자·팀 화면에서 예산을 등록하면 소진율과 예상 초과 시점을 계산합니다."
          />
        ) : (
          <ul className="finops-list">
            {budgets.map((status, index) => (
              <li key={status.budget?.id || index}>
                <Badge
                  tone={
                    budgetTone(status) === "danger"
                      ? "danger"
                      : budgetTone(status) === "warning"
                        ? "warning"
                        : "success"
                  }
                >
                  {status.on_track ? "정상" : "초과 예상"}
                </Badge>
                <strong>
                  {dimensionLabels[status.budget?.scope ?? ""] ?? status.budget?.scope}
                  {status.budget?.scope_value ? ` · ${status.budget.scope_value}` : ""}
                </strong>
                <span className="finops-meta">
                  {formatKRW(status.spent_krw)} / {formatKRW(status.budget?.monthly_krw)} (
                  {formatPercent(status.burn_ratio)}) · 월말 예상 {formatKRW(status.projected_krw)}
                  {status.exhaustion_date ? ` · 소진 예상 ${status.exhaustion_date}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="모델 전환 후보"
        description="20건 이상 요청된 상위 10개 프롬프트 군집에서 찾은 후보입니다. 예상 절감은 조회된 후보의 추정치이며 보장된 절감액이 아닙니다."
      >
        {failed("migration_candidates") ? (
          sectionFailure("모델 전환 후보")
        ) : (
          <DataTable
            caption="모델 전환 후보"
            columns={migrationColumns}
            data={migrations}
            emptyMessage="전환 후보가 없습니다. 같은 작업이 충분히 반복되면 후보가 나타납니다."
            error={billing.isError && !billing.data ? "비용 대시보드를 불러오지 못했습니다." : undefined}
            getRowId={(row, index) => row.fingerprint || String(index)}
            loading={billing.isPending}
            onRetry={() => void billing.refetch()}
          />
        )}
      </SectionCard>
    </div>
  );
}
