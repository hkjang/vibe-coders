import { SimpleTable } from "@/features/data/SimpleTable";
import type { ModelMigrationRecommendation, SavingsScope } from "@/shared/api/domains/data.schemas";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";
import { dwDimensionLabels, type DwDimension } from "./warehouse-filters";
import { InsightQueryStatus } from "./InsightQueryStatus";
import type { InsightsQueries } from "./use-warehouse-queries";
export function DwSavingsPanel({
  savings,
  modelMigration,
  dimension,
}: {
  savings: InsightsQueries["savings"];
  modelMigration: InsightsQueries["modelMigration"];
  dimension: DwDimension;
}): React.JSX.Element {
  return (
    <SectionCard
      title="비용 절감·모델 전환"
      description="다운시프트와 캐시로 아낀 금액, 그리고 지금 바꿀 만한 모델 후보입니다. 운영 데이터베이스에서 실시간으로 계산합니다."
    >
      <InsightQueryStatus query={savings} label="비용 절감" />
      <InsightQueryStatus query={modelMigration} label="모델 전환 추천" />
      <StatGrid label="절감 지표">
        <StatCard
          label="총 절감액"
          value={formatKRW(savings.data?.total_savings_krw)}
          hint="다운시프트 + 캐시"
        />
        <StatCard label="다운시프트 절감" value={formatKRW(savings.data?.total_downshift_savings_krw)} />
        <StatCard
          label="캐시 절감"
          value={formatKRW(savings.data?.total_cache_savings_krw)}
          hint={savings.data?.cache_savings_estimated ? "추정치" : undefined}
        />
        <StatCard
          label="전환 예상 절감"
          value={formatKRW(modelMigration.data?.total_estimated_savings_krw)}
          hint={`추천 ${formatNumber(modelMigration.data?.count ?? 0)}건`}
        />
      </StatGrid>
      <SimpleTable<SavingsScope>
        caption={`${dwDimensionLabels[dimension]}별 절감액`}
        loading={savings.isPending}
        rows={savings.data?.scopes ?? []}
        emptyMessage="집계된 절감액이 없습니다."
        columns={[
          { id: "scope", header: dwDimensionLabels[dimension], cell: (row) => row.scope || "—" },
          {
            id: "downshift",
            header: "다운시프트",
            cell: (row) => <span className="cell-number">{formatNumber(row.downshift_requests)}</span>,
          },
          {
            id: "downshift_krw",
            header: "다운시프트 절감",
            cell: (row) => <span className="cell-number">{formatKRW(row.downshift_savings_krw)}</span>,
          },
          {
            id: "cache",
            header: "캐시 적중",
            cell: (row) => <span className="cell-number">{formatNumber(row.cache_hits)}</span>,
          },
          {
            id: "total",
            header: "합계",
            cell: (row) => <span className="cell-number">{formatKRW(row.total_savings_krw)}</span>,
          },
        ]}
      />
      <SimpleTable<ModelMigrationRecommendation>
        caption="모델 전환 추천"
        loading={modelMigration.isPending}
        rows={modelMigration.data?.recommendations ?? []}
        emptyMessage="전환을 추천할 만한 작업 유형이 없습니다."
        columns={[
          { id: "task", header: "작업 유형", cell: (row) => row.task_type || "—" },
          {
            id: "requests",
            header: "요청",
            cell: (row) => <span className="cell-number">{formatNumber(row.requests)}</span>,
          },
          { id: "current", header: "현재 모델", cell: (row) => row.current_model || "—" },
          { id: "recommended", header: "추천 모델", cell: (row) => row.recommended_model || "—" },
          {
            id: "success",
            header: "성공률",
            cell: (row) =>
              `${formatPercent(row.current_success_rate)} → ${formatPercent(row.recommended_success_rate)}`,
          },
          {
            id: "savings",
            header: "예상 절감",
            cell: (row) => <span className="cell-number">{formatKRW(row.estimated_savings_krw)}</span>,
          },
        ]}
      />
    </SectionCard>
  );
}
