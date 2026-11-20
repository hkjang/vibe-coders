import type { ScatterPoint } from "@/shared/api/domains/observability.schemas";
import { Button } from "@/shared/components/ui/Button";
import { ExpandableCellText } from "@/shared/data-table/ExpandableCellText";
import { RowSelectionCheckbox } from "@/shared/data-table/RowSelectionCheckbox";
import { formatNumber } from "@/shared/utils/format";
import { formatScatterMetric, metricValue, scatterMetrics } from "./scatter-model";
import { useScatterTableBindings } from "./scatter-table-bindings";

interface PointCellProps {
  row: { original: ScatterPoint };
}

export function SelectAllHeader() {
  const { points, bulk } = useScatterTableBindings();
  return (
    <RowSelectionCheckbox
      label={`산점도에 표시된 전체 ${formatNumber(points.length)}건 선택`}
      checked={bulk.all}
      mixed={bulk.mixed}
      disabled={points.length === 0}
      onChange={bulk.toggleAll}
    />
  );
}

export function SelectionCell({ row }: PointCellProps) {
  const { bulk } = useScatterTableBindings();
  return (
    <RowSelectionCheckbox
      label={`${row.original.request_id} 비교 대상으로 선택`}
      checked={bulk.has(row.original)}
      disabled={false}
      onChange={() => bulk.toggle(row.original)}
    />
  );
}

export function CategoryCell({ row }: PointCellProps) {
  const { categoryLabel } = useScatterTableBindings();
  return <ExpandableCellText value={categoryLabel(row.original)} />;
}

export function MetricHeader() {
  const { metric } = useScatterTableBindings();
  return scatterMetrics.find((item) => item.value === metric)?.label ?? "지표";
}

export function MetricCell({ row }: PointCellProps) {
  const { metric } = useScatterTableBindings();
  return (
    <span className="cell-number">{formatScatterMetric(metric, metricValue(row.original, metric))}</span>
  );
}

export function OpenCell({ row }: PointCellProps) {
  const { bulk, onSelect } = useScatterTableBindings();
  return (
    <Button
      size="small"
      onClick={(event) => {
        if (bulk.isCurrent()) onSelect([row.original], event.currentTarget);
      }}
      aria-label={`${row.original.request_id} 선택`}
    >
      입출력
    </Button>
  );
}
