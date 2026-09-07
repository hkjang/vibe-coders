import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";

import { QuerySection, ScopeNotice } from "@/features/security/security-ui";
import {
  isPrivacyDimension,
  privacyDays,
  privacyDimensionLabels,
} from "@/features/security/overview/security-overview";
import { downloadPrivacyLedgerCsv } from "@/features/security/overview/privacy-ledger-export";
import { apiClient } from "@/shared/api/client";
import {
  privacyLedgerDimensions,
  type PrivacyLedgerQuery,
  type PrivacyLedgerRow,
} from "@/shared/api/domains/security";
import { endpoints } from "@/shared/api/endpoints";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatNumber } from "@/shared/utils/format";

const dayOptions = ["7", "30", "90", "365"] as const;

function ledgerColumns(dimensionLabel: string): ReadonlyArray<DataTableColumn<PrivacyLedgerRow>> {
  const column = createDataTableColumnHelper<PrivacyLedgerRow>();
  return column.columns([
    column.accessor((row) => row.dim_value, {
      id: "dim_value",
      header: dimensionLabel,
      cell: ({ getValue }) => <span className="cell-mono">{getValue() || "—"}</span>,
    }),
    column.accessor((row) => row.detections, {
      id: "detections",
      header: "탐지",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.masked, {
      id: "masked",
      header: "마스킹",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.blocked, {
      id: "blocked",
      header: "차단",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.egress_requests, {
      id: "egress_requests",
      header: "전송 요청",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.egress_tokens, {
      id: "egress_tokens",
      header: "전송 토큰",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
  ]) as Array<DataTableColumn<PrivacyLedgerRow>>;
}

interface PrivacyLedgerTabProps {
  canRead: boolean;
  refreshInterval: number | false;
}

export function PrivacyLedgerTab({ canRead, refreshInterval }: PrivacyLedgerTabProps): React.JSX.Element {
  const [params, updateSearch] = useSearchState();
  const requestedDimension = params.get("dimension");
  const dimension = isPrivacyDimension(requestedDimension) ? requestedDimension : "team";
  const days = privacyDays(params.get("days"));

  const query: PrivacyLedgerQuery = { dimension, days };
  const ledger = useQuery({
    queryKey: ["security", "privacy-ledger", dimension, days],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.security.privacyLedger, {
        query,
        signal,
        routeId: "security.overview",
      }),
    enabled: canRead,
    refetchInterval: refreshInterval,
    refetchIntervalInBackground: false,
  });

  const csv = useMutationFeedback<null, null>({
    mutate: async () => {
      await downloadPrivacyLedgerCsv(dimension, days);
      return null;
    },
    successMessage: "프라이버시 원장 CSV를 내려받았습니다.",
    errorMessage: "프라이버시 원장 CSV를 내려받지 못했습니다.",
  });

  if (!canRead) return <ScopeNotice scope="admin:read" what="프라이버시 원장" />;

  const totals = ledger.data?.totals;
  const rows = ledger.data?.rows ?? [];

  return (
    <>
      <Toolbar
        label="프라이버시 원장 조건"
        end={
          <Button size="small" onClick={() => csv.mutate(null)} disabled={csv.isPending}>
            <Download aria-hidden="true" /> {csv.isPending ? "내보내는 중" : "CSV 내보내기"}
          </Button>
        }
      >
        <FormField label="차원">
          {(control) => (
            <Select
              {...control}
              value={dimension}
              onChange={(event) => updateSearch({ dimension: event.target.value })}
            >
              {privacyLedgerDimensions.map((value) => (
                <option key={value} value={value}>
                  {privacyDimensionLabels[value]}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="조회 일수">
          {(control) => (
            <Select
              {...control}
              value={String(days)}
              onChange={(event) => updateSearch({ days: event.target.value })}
            >
              {dayOptions.map((value) => (
                <option key={value} value={value}>
                  {value}일
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </Toolbar>

      <QuerySection
        error={ledger.isError ? ledger.error : undefined}
        hasData={Boolean(ledger.data)}
        label="프라이버시 원장"
        onRetry={() => void ledger.refetch()}
        pending={ledger.isPending}
      >
        <StatGrid label="프라이버시 원장 합계">
          <StatCard label="탐지" value={formatNumber(totals?.detections ?? 0)} />
          <StatCard label="마스킹" tone="warning" value={formatNumber(totals?.masked ?? 0)} />
          <StatCard label="차단" tone="danger" value={formatNumber(totals?.blocked ?? 0)} />
          <StatCard label="전송 요청" value={formatNumber(totals?.egress_requests ?? 0)} />
          <StatCard label="전송 토큰" value={formatNumber(totals?.egress_tokens ?? 0)} />
        </StatGrid>

        <SectionCard
          title={`프라이버시 원장 (최근 ${formatNumber(ledger.data?.days ?? days)}일, ${privacyDimensionLabels[dimension]})`}
          description={ledger.data?.note}
        >
          <DataTable
            caption="프라이버시 원장"
            columns={ledgerColumns(privacyDimensionLabels[dimension])}
            data={rows}
            emptyMessage="집계된 데이터가 없습니다."
            getRowId={(row, index) => row.dim_value || `row-${index}`}
          />
        </SectionCard>
      </QuerySection>
    </>
  );
}
