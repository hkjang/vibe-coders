import { SimpleTable } from "@/features/data/SimpleTable";
import type { DwDimensionRow } from "@/shared/api/domains/data.schemas";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { formatNumber, formatKRW, formatPercent } from "@/shared/utils/format";
import { dwDimensionLabels, dwOrderLabels, type DwDimension, type DwOrder } from "./warehouse-filters";
import type { InsightsQueries } from "./use-warehouse-queries";
import { InsightQueryStatus } from "./InsightQueryStatus";
export function DwDimensionsPanel({
  dimensions,
  dimension,
  order,
  periodLabel,
  ready,
}: {
  dimensions: InsightsQueries["dimensions"];
  dimension: DwDimension;
  order: DwOrder;
  periodLabel: string;
  ready: boolean;
}): React.JSX.Element {
  return (
    <SectionCard
      title={`${dwDimensionLabels[dimension]}별 Top 10`}
      description={`${dwOrderLabels[order]} 정렬 · ${periodLabel}`}
    >
      <InsightQueryStatus query={dimensions} label="차원별 집계" />
      {!ready ? (
        <InlineNotice tone="warning" title="선택 기간을 확인할 수 없습니다.">
          전체 기간으로 돌아가거나 서버 응답을 다시 확인하세요. 선택 기간이 적용되지 않은 집계는 표시하지
          않습니다.
        </InlineNotice>
      ) : (
        <SimpleTable<DwDimensionRow>
          caption={`${dwDimensionLabels[dimension]}별 사용량과 비용`}
          loading={dimensions.isPending}
          rows={dimensions.data?.rows ?? []}
          emptyMessage="집계된 항목이 없습니다."
          columns={[
            { id: "value", header: dwDimensionLabels[dimension], cell: (row) => row.value || "—" },
            {
              id: "requests",
              header: "요청",
              cell: (row) => <span className="cell-number">{formatNumber(row.requests)}</span>,
            },
            {
              id: "tokens",
              header: "토큰",
              cell: (row) => <span className="cell-number">{formatNumber(row.tokens)}</span>,
            },
            {
              id: "cost",
              header: "비용",
              cell: (row) => <span className="cell-number">{formatKRW(row.cost_krw)}</span>,
            },
            {
              id: "error_rate",
              header: "오류율",
              cell: (row) => <span className="cell-number">{formatPercent(row.error_rate)}</span>,
            },
          ]}
        />
      )}
    </SectionCard>
  );
}
