import { FinopsReadBoundary } from "./FinopsReadBoundary";
import { useFinopsReadQuery } from "./use-finops-read-query";
import { useChargebackExport } from "./use-chargeback-export";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Download } from "lucide-react";
import { useState } from "react";

import {
  currentMonth,
  dimensionLabels,
  finopsChargebackQueryKey,
  monthPattern,
} from "@/features/finops/overview/finops-shared";
import { CostQueryFailure } from "@/features/finops/overview/finops-ui";
import { apiClient } from "@/shared/api/client";
import type { CostAllocationRow } from "@/shared/api/domains/finops";
import { endpoints } from "@/shared/api/endpoints";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime, formatKRW, formatNumber } from "@/shared/utils/format";

function packColumns(): ReadonlyArray<DataTableColumn<CostAllocationRow>> {
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

export function ChargebackTab(): React.JSX.Element {
  return (
    <FinopsReadBoundary scope="chargeback">
      {(owner) => <ChargebackPeriod owner={owner} />}
    </FinopsReadBoundary>
  );
}
function ChargebackPeriod({ owner }: { owner: FeatureReadOwner }): React.JSX.Element {
  const [searchParams] = useSearchState();
  const month = searchParams.get("month") || currentMonth();
  return <ChargebackContent key={month} owner={owner} month={month} />;
}
function ChargebackContent({ owner, month }: { owner: FeatureReadOwner; month: string }): React.JSX.Element {
  const [, updateSearch] = useSearchState();
  const invalidMonth = !monthPattern.test(month);
  const [monthInput, setMonthInput] = useState(month);
  const [monthError, setMonthError] = useState<string | undefined>(
    invalidMonth ? "YYYY-MM 형식으로 입력하세요." : undefined,
  );
  const { download, downloading, downloadError } = useChargebackExport(owner, month);

  const pack = useFinopsReadQuery(
    owner,
    [...finopsChargebackQueryKey, month],
    (signal) =>
      apiClient.request(endpoints.domains.finops.chargebackPack, {
        query: { month },
        signal,
        routeId: "finops.overview",
      }),
    false,
    !invalidMonth,
  );

  const dimensions = pack.data?.dimensions ?? [];
  const totalCost = dimensions[0]?.total_cost_krw ?? 0;
  const totalRequests = dimensions[0]?.total_requests ?? 0;
  const unavailable = pack.isPending || (pack.isError && !pack.data);

  const applyMonth = (): void => {
    const next = monthInput.trim();
    if (next !== "" && !monthPattern.test(next)) {
      setMonthError("YYYY-MM 형식으로 입력하세요.");
      return;
    }
    setMonthError(undefined);
    setMonthInput(next || currentMonth());
    updateSearch({ month: next || undefined });
  };

  return (
    <div className="finops-panel-stack">
      <SectionCard
        title="월별 비용 배부 팩"
        description="비용센터·프로젝트·팀 차원을 한 번에 산출한 내부 정산용 자료입니다."
        actions={
          <div className="finops-form">
            <Button onClick={applyMonth}>조회</Button>
            <Button
              variant="primary"
              disabled={
                downloading || pack.isFetching || pack.isError || !pack.data || monthInput.trim() !== month
              }
              onClick={() => void download()}
            >
              <Download aria-hidden="true" /> {downloading ? "내려받는 중" : "CSV 다운로드"}
            </Button>
          </div>
        }
      >
        <div className="finops-form">
          <FormField
            label="정산 월"
            description="비우면 이번 달(KST 기준)입니다. 입력 후 조회를 눌러 적용하세요. CSV는 적용한 월만 내려받습니다."
            error={monthError}
          >
            {(control) => (
              <Input
                {...control}
                value={monthInput}
                placeholder="2026-09"
                onChange={(event) => setMonthInput(event.target.value)}
              />
            )}
          </FormField>
        </div>
        {downloadError ? (
          <InlineNotice tone="danger" title="CSV 다운로드 실패">
            {downloadError}
          </InlineNotice>
        ) : null}
        {pack.isError ? (
          <CostQueryFailure
            error={pack.error}
            hasData={Boolean(pack.data)}
            label="비용 배부 팩"
            onRetry={() => void pack.refetch()}
          />
        ) : null}
        <StatGrid label="비용 배부 팩 요약">
          <StatCard label="정산 월" value={unavailable ? "—" : (pack.data?.month ?? "—")} />
          <StatCard
            label={`${dimensionLabels[dimensions[0]?.dimension ?? ""] ?? "첫 차원"} 합계`}
            value={unavailable ? "—" : formatKRW(totalCost)}
          />
          <StatCard label="합계 요청" value={unavailable ? "—" : formatNumber(totalRequests)} />
          <StatCard label="생성 시각" value={unavailable ? "—" : formatDateTime(pack.data?.generated_at)} />
        </StatGrid>
      </SectionCard>

      {pack.isPending && !invalidMonth ? <LoadingState label="비용 배부 팩을 불러오는 중입니다." /> : null}
      {dimensions.length === 0 && pack.data ? (
        <EmptyState
          title="배부할 비용이 없습니다."
          description="해당 월에 집계된 요청이 없거나 비용 메타데이터가 없습니다."
        />
      ) : null}

      {dimensions.map((entry) => (
        <SectionCard
          key={entry.dimension}
          title={`${dimensionLabels[entry.dimension] ?? entry.dimension} 배부`}
          description={`합계 ${formatKRW(entry.total_cost_krw)} · 요청 ${formatNumber(entry.total_requests)}`}
          headingLevel={3}
        >
          <DataTable
            caption={`${dimensionLabels[entry.dimension] ?? entry.dimension} 비용 배부`}
            columns={packColumns()}
            data={entry.rows}
            emptyMessage="이 차원에 배부된 비용이 없습니다."
            getRowId={(row, index) => `${entry.dimension}-${row.key || index}`}
            loading={pack.isPending}
          />
        </SectionCard>
      ))}
    </div>
  );
}
