import { Heatmap } from "@/features/insights/charts/Heatmap";
import type { WorkMetricId } from "@/shared/api/domains/insights-common";
import type { WorkMatrix } from "@/shared/api/domains/insights-usage";

import { formatMetric, metricValue, suppressedHint, suppressedLabel } from "../usage-metrics";

export const noTeamLabel = "(팀 없음)";

interface MatrixPanelProps {
  data: WorkMatrix;
  metric: WorkMetricId;
  minGroupSize: number;
  onSelectCell: (team: string, categoryId: string) => void;
  onSelectCategory: (categoryId: string) => void;
}

/** 조직 × 업무: which team uses AI for which work, in the selected metric. */
export function MatrixPanel({
  data,
  metric,
  minGroupSize,
  onSelectCell,
  onSelectCategory,
}: MatrixPanelProps): React.JSX.Element {
  return (
    <Heatmap
      caption="조직별 업무 활용 히트맵"
      rowHeader="조직"
      totalHeader="합계"
      columns={data.categories.map((category) => ({ id: category.id, label: category.name || category.id }))}
      rows={data.rows.map((row, index) => {
        const total = metricValue(row.total, metric);
        return {
          // Team names are the row identity; an empty name is the "no team" bucket.
          id: row.team || `__none-${index}`,
          label: row.team || noTeamLabel,
          total: total === null ? suppressedLabel : formatMetric(total, metric),
          cells: row.cells.map((cell) => ({
            columnId: cell.category_id,
            value: cell.value,
            suppressed: cell.suppressed,
            display: formatMetric(cell.value, metric),
          })),
        };
      })}
      suppressedLabel={suppressedLabel}
      suppressedHint={suppressedHint(minGroupSize)}
      onSelectCell={(team, categoryId) => {
        if (!team.startsWith("__none-")) onSelectCell(team, categoryId);
      }}
      onSelectColumn={onSelectCategory}
      selectHint="이 조직·업무의 세션 보기"
    />
  );
}
