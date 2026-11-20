import { useState } from "react";
import type { ScatterPoint } from "@/shared/api/domains/observability.schemas";
import { Button } from "@/shared/components/ui/Button";
import { Select } from "@/shared/components/ui/Select";
import { DataTable } from "@/shared/data-table/DataTable";
import { createDataTableColumnHelper } from "@/shared/data-table/columns";
import { ExpandableCellText } from "@/shared/data-table/ExpandableCellText";
import { RowSelectionCheckbox } from "@/shared/data-table/RowSelectionCheckbox";
import { usePageRowSelection } from "@/shared/data-table/use-page-row-selection";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import { formatScatterMetric, metricValue, scatterMetrics, type ScatterMetric } from "./scatter-model";

const column = createDataTableColumnHelper<ScatterPoint>();
const identity = (point: ScatterPoint) => point.request_id;
const current = () => true;
const lockedColumns = ["select", "request", "action"];
const pageSizes = [50, 100, 200];

interface Props {
  points: ReadonlyArray<ScatterPoint>;
  metric: ScatterMetric;
  categoryLabel: (point: ScatterPoint) => string;
  onSelect: (points: ReadonlyArray<ScatterPoint>, trigger?: HTMLElement) => void;
}

/** Pages the complete plotted buffer; selection belongs to this received buffer, not one page. */
export function ScatterRequestTable({ points, metric, categoryLabel, onSelect }: Props) {
  const [paging, setPaging] = useState({ frame: points, page: 0, size: 50 });
  if (paging.frame !== points) setPaging({ frame: points, page: 0, size: paging.size });
  const bulk = usePageRowSelection(points, points, identity, current);
  const pageCount = Math.max(1, Math.ceil(points.length / paging.size));
  const page = paging.frame === points ? Math.min(paging.page, pageCount - 1) : 0;
  const end = points.length - page * paging.size;
  const rows = points.slice(Math.max(0, end - paging.size), end).reverse();
  const columns = [
    column.display({
      id: "select",
      header: () => (
        <RowSelectionCheckbox
          label={`산점도에 표시된 전체 ${formatNumber(points.length)}건 선택`}
          checked={bulk.all}
          mixed={bulk.mixed}
          disabled={points.length === 0}
          onChange={bulk.toggleAll}
        />
      ),
      meta: { label: "선택" },
      size: 80,
      cell: ({ row }) => (
        <RowSelectionCheckbox
          label={`${row.original.request_id} 비교 대상으로 선택`}
          checked={bulk.has(row.original)}
          disabled={false}
          onChange={() => bulk.toggle(row.original)}
        />
      ),
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
    column.display({
      id: "category",
      header: "구분",
      size: 120,
      cell: ({ row }) => <ExpandableCellText value={categoryLabel(row.original)} />,
    }),
    column.display({
      id: "metric",
      header: scatterMetrics.find((item) => item.value === metric)?.label ?? "지표",
      size: 140,
      cell: ({ row }) => (
        <span className="cell-number">{formatScatterMetric(metric, metricValue(row.original, metric))}</span>
      ),
    }),
    column.display({
      id: "action",
      header: "작업",
      size: 100,
      cell: ({ row }) => (
        <Button
          size="small"
          onClick={(event) => {
            if (bulk.isCurrent()) onSelect([row.original], event.currentTarget);
          }}
          aria-label={`${row.original.request_id} 선택`}
        >
          입출력
        </Button>
      ),
    }),
  ];

  return (
    <div className="xview-point-table">
      <p className="obs-meta">
        표를 보는 동안 자동 갱신을 멈춥니다. 표를 닫으면 실시간 설정에 따라 다시 갱신합니다. 새 응답이나 표시
        대상이 바뀌면 선택을 초기화합니다.
      </p>
      <div className="xview-point-table-actions">
        <span role="status">
          표시된 {formatNumber(points.length)}건 중 {formatNumber(bulk.count)}건 선택
        </span>
        <Button
          size="small"
          disabled={bulk.count === 0}
          onClick={(event) => {
            if (bulk.isCurrent()) onSelect(bulk.selectedRows, event.currentTarget);
          }}
        >
          {bulk.count > 1 ? `선택한 ${formatNumber(bulk.count)}건 비교` : "선택한 요청 열기"}
        </Button>
        <Button size="small" variant="secondary" disabled={bulk.count === 0} onClick={bulk.clear}>
          선택 해제
        </Button>
        <label className="xview-point-table-page">
          <span>페이지 이동</span>
          <Select
            value={page}
            onChange={(event) => {
              const next = Number(event.currentTarget.value);
              if (Number.isInteger(next) && next >= 0 && next < pageCount)
                setPaging({ ...paging, frame: points, page: next });
            }}
          >
            {Array.from({ length: pageCount }, (_, index) => (
              <option key={index} value={index}>
                {index + 1} / {pageCount}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <DataTable
        caption="산점도에 표시된 요청"
        tableId="xview-plotted-requests"
        lockedColumnIds={lockedColumns}
        columns={columns}
        data={rows}
        getRowId={identity}
        emptyMessage="현재 범례 조건에 표시되는 요청이 없습니다. 범례를 다시 켜 주세요."
        pageIndex={page}
        pageCount={pageCount}
        onPageChange={(next) => setPaging({ ...paging, frame: points, page: next })}
        pageSizeControl={{
          value: paging.size,
          options: pageSizes,
          onChange: (size) => setPaging({ frame: points, page: 0, size }),
        }}
      />
    </div>
  );
}
