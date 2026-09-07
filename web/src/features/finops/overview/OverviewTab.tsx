import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import {
  costWindowFrom,
  costWindows,
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
  const [searchParams, updateSearch] = useSearchState();
  const window = costWindowFrom(searchParams.get("window"));
  const refreshInterval = useRefreshInterval();

  const billing = useQuery({
    queryKey: [...finopsBillingQueryKey, window],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.finops.billingDashboard, {
        query: { window },
        signal,
        routeId: "finops.overview",
      }),
    refetchInterval: refreshInterval,
  });

  const unavailable = billing.isPending || (billing.isError && !billing.data);
  const budgets = billing.data?.budgets ?? [];
  const migrations = billing.data?.migration_candidates ?? [];
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
                {item}
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
        <StatCard label="총 비용" value={unavailable ? "—" : formatKRW(billing.data?.total_cost_krw)} />
        <StatCard label="총 요청" value={unavailable ? "—" : formatNumber(billing.data?.total_requests)} />
        <StatCard
          label="예상 절감 가능액"
          tone={(billing.data?.estimated_savings_krw ?? 0) > 0 ? "success" : "default"}
          value={unavailable ? "—" : formatKRW(billing.data?.estimated_savings_krw)}
        />
        <StatCard
          label="예산 항목"
          tone={budgets.some((budget) => !budget.on_track) ? "warning" : "default"}
          value={unavailable ? "—" : formatNumber(budgets.length)}
        />
      </StatGrid>

      <SectionCard title="비용센터별 비용" description={`${window} 동안 비용센터에 배부된 금액입니다.`}>
        {(billing.data?.by_cost_center.length ?? 0) === 0 ? (
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

      <SectionCard title="모델별 비용" description={`${window} 동안 모델별로 집계한 비용입니다.`}>
        {(billing.data?.by_model.length ?? 0) === 0 ? (
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

      <SectionCard title="예산 소진율" description="이번 달 예산 대비 사용액과 추세입니다.">
        {budgets.length === 0 ? (
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

      <SectionCard title="모델 전환 후보" description="같은 작업을 더 싸게 처리할 수 있는 모델 후보입니다.">
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
      </SectionCard>
    </div>
  );
}
