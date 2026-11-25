import type { ScatterPoint } from "@/shared/api/domains/observability.schemas";
import { createDataTableColumnHelper } from "@/shared/data-table/columns";
import { ExpandableCellText } from "@/shared/data-table/ExpandableCellText";
import { formatDateTime } from "@/shared/utils/format";
import {
  CategoryCell,
  MetricCell,
  MetricHeader,
  OpenCell,
  SelectAllHeader,
  SelectionCell,
} from "./ScatterRequestCells";

const column = createDataTableColumnHelper<ScatterPoint>();

// FlexRender treats renderers as component types. Keep those types stable;
// context updates their data without replacing focused inputs or disclosures.
export const scatterRequestColumns = [
  column.display({
    id: "select",
    header: SelectAllHeader,
    meta: { label: "선택" },
    size: 80,
    cell: SelectionCell,
  }),
  column.display({
    id: "time",
    header: "시각",
    size: 190,
    cell: ({ row }) => (
      <time dateTime={row.original.created_at}>{formatDateTime(row.original.created_at)}</time>
    ),
  }),
  column.display({
    id: "request",
    header: "요청 ID",
    size: 240,
    cell: ({ row }) => <ExpandableCellText value={row.original.request_id} mono />,
  }),
  column.display({
    id: "model",
    header: "모델",
    size: 200,
    cell: ({ row }) => <ExpandableCellText value={row.original.model || "(미상)"} />,
  }),
  column.display({ id: "category", header: "구분", size: 120, cell: CategoryCell }),
  column.display({
    id: "metric",
    header: MetricHeader,
    meta: { label: "지표" },
    size: 140,
    cell: MetricCell,
  }),
  column.display({ id: "action", header: "작업", size: 100, cell: OpenCell }),
];
