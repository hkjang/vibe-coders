import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";

import {
  allocationDimensionFrom,
  allocationDimensions,
  costWindowFrom,
  costWindows,
  dimensionLabels,
  finopsAllocationQueryKey,
} from "@/features/finops/overview/finops-shared";
import { CostBars, CostQueryFailure } from "@/features/finops/overview/finops-ui";
import { apiClient } from "@/shared/api/client";
import type { CostAllocationRow } from "@/shared/api/domains/finops";
import { endpoints } from "@/shared/api/endpoints";
import { Button } from "@/shared/components/ui/Button";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { downloadCsv, toCsv } from "@/shared/utils/csv";
import { formatDateTime, formatKRW, formatNumber } from "@/shared/utils/format";

function allocationColumns(): ReadonlyArray<DataTableColumn<CostAllocationRow>> {
  const column = createDataTableColumnHelper<CostAllocationRow>();
  return column.columns([
    column.accessor((row) => row.key, {
      id: "key",
      header: "항목",
      cell: ({ getValue }) => <strong>{getValue() || "(미지정)"}</strong>,
    }),
    column.accessor((row) => row.requests, {
      id: "requests",
      header: "요청",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.tokens, {
      id: "tokens",
      header: "토큰",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.cost_krw, {
      id: "cost",
      header: "비용",
      cell: ({ getValue }) => <span className="cell-number">{formatKRW(getValue())}</span>,
    }),
    column.accessor((row) => row.error_requests, {
      id: "errors",
      header: "오류 요청",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
  ]);
}

export function AllocationTab(): React.JSX.Element {
  const [searchParams, updateSearch] = useSearchState();
  const window = costWindowFrom(searchParams.get("window"));
  const dimension = allocationDimensionFrom(searchParams.get("dimension"));

  const allocation = useQuery({
    queryKey: [...finopsAllocationQueryKey, dimension, window],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.finops.costAllocation, {
        query: { dimension, window, limit: 100 },
        signal,
        routeId: "finops.overview",
      }),
    placeholderData: keepPreviousData,
  });

  const rows = allocation.data?.rows ?? [];
  const totalCost = rows.reduce((sum, row) => sum + row.cost_krw, 0);
  const totalRequests = rows.reduce((sum, row) => sum + row.requests, 0);
  const unavailable = allocation.isPending || (allocation.isError && !allocation.data);

  return (
    <div className="finops-panel-stack">
      <Toolbar
        label="비용 배부 조회 조건"
        end={
          <Button
            disabled={rows.length === 0}
            onClick={() =>
              downloadCsv(
                `cost-allocation-${dimension}-${window}`,
                toCsv(rows, [
                  { header: "key", value: (row) => row.key },
                  { header: "requests", value: (row) => row.requests },
                  { header: "tokens", value: (row) => row.tokens },
                  { header: "cost_krw", value: (row) => row.cost_krw },
                  { header: "error_requests", value: (row) => row.error_requests },
                ]),
              )
            }
          >
            <Download aria-hidden="true" /> CSV 내보내기
          </Button>
        }
      >
        <label className="form-field">
          <span>배부 기준</span>
          <select
            className="input select"
            value={dimension}
            onChange={(event) => updateSearch({ dimension: event.target.value })}
          >
            {allocationDimensions.map((item) => (
              <option key={item} value={item}>
                {dimensionLabels[item] ?? item}
              </option>
            ))}
          </select>
        </label>
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
          마지막 갱신 {allocation.dataUpdatedAt ? formatDateTime(allocation.dataUpdatedAt) : "—"}
        </span>
      </Toolbar>

      {allocation.isError ? (
        <CostQueryFailure
          error={allocation.error}
          hasData={Boolean(allocation.data)}
          label="비용 배부"
          onRetry={() => void allocation.refetch()}
        />
      ) : null}

      <StatGrid label="비용 배부 요약">
        <StatCard label="합계 비용" value={unavailable ? "—" : formatKRW(totalCost)} />
        <StatCard label="합계 요청" value={unavailable ? "—" : formatNumber(totalRequests)} />
        <StatCard label="항목 수" value={unavailable ? "—" : formatNumber(rows.length)} />
        <StatCard label="집계 시작" value={unavailable ? "—" : formatDateTime(allocation.data?.since)} />
      </StatGrid>

      <SectionCard
        title={`${dimensionLabels[dimension] ?? dimension}별 비용`}
        description="상위 항목부터 비용 순으로 보여 줍니다."
      >
        {rows.length === 0 ? null : (
          <CostBars
            label={`${dimensionLabels[dimension] ?? dimension}별 비용`}
            items={rows.slice(0, 10).map((row) => ({
              label: row.key || "(미지정)",
              value: row.cost_krw,
              display: `${formatKRW(row.cost_krw)} · 요청 ${formatNumber(row.requests)}`,
              tone: row.error_requests > 0 ? "warning" : "default",
            }))}
          />
        )}
        <DataTable
          caption={`${dimensionLabels[dimension] ?? dimension}별 비용 배부`}
          columns={allocationColumns()}
          data={rows}
          emptyMessage="이 기준으로 집계할 비용이 없습니다. 요청에 해당 메타데이터가 붙어야 집계됩니다."
          error={allocation.isError && !allocation.data ? "비용 배부를 불러오지 못했습니다." : undefined}
          getRowId={(row, index) => row.key || String(index)}
          loading={allocation.isPending}
          onRetry={() => void allocation.refetch()}
        />
      </SectionCard>
    </div>
  );
}
