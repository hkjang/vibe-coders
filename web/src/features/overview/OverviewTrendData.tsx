import { useId, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { TimeSeriesChart } from "@/features/observability/charts";
import type { AdminTimeseries } from "@/shared/api/schemas";
import { Button } from "@/shared/components/ui/Button";
import { DataTable, type DataTableSort } from "@/shared/data-table/DataTable";
import type { DataTableColumn } from "@/shared/data-table/columns";
import { downloadCsv, toCsv } from "@/shared/utils/csv";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import { formatPreciseNumber } from "@/shared/utils/precise-number";
import { trendBucket, trendCost, trendSince, type TrendPoint, type TrendWindow } from "./overview-trend";

type Row = TrendPoint & { label: string; iso: string; ordinal: number };
const columns: DataTableColumn<Row>[] = [
  { id: "date", header: "구간 시작 (한국 시간)", accessorFn: (row) => row.label },
  {
    id: "requests",
    header: "요청 (건)",
    accessorKey: "requests",
    cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.requests)}</span>,
  },
  {
    id: "tokens",
    header: "토큰 (개)",
    accessorKey: "tokens",
    cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.tokens)}</span>,
  },
  {
    id: "cost_krw",
    header: "비용 (원)",
    accessorKey: "cost_krw",
    cell: ({ row }) => <span className="cell-number">{trendCost(row.original.cost_krw)}</span>,
  },
];
const sortable = [
  { id: "date", initialDirection: "asc", sortLabel: "구간 시작" },
  { id: "requests", initialDirection: "desc", sortLabel: "요청" },
  { id: "tokens", initialDirection: "desc", sortLabel: "토큰" },
  { id: "cost_krw", initialDirection: "desc", sortLabel: "비용" },
] as const;

export function OverviewTrendData({
  data,
  label,
  range,
  isDataCurrent,
}: {
  data: AdminTimeseries;
  label: string;
  range: TrendWindow;
  isDataCurrent: () => boolean;
}): React.JSX.Element {
  const tableId = useId();
  const [sorting, setSorting] = useState<DataTableSort>({ columnId: "date", direction: "asc" });
  const rows = useMemo(
    () => data.points.map((point, ordinal) => ({ ...point, ...trendBucket(point), ordinal })),
    [data],
  );
  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const field = sorting.columnId;
        const compared =
          field === "date"
            ? a.iso.localeCompare(b.iso)
            : field === "requests"
              ? a.requests - b.requests
              : field === "tokens"
                ? a.tokens - b.tokens
                : a.cost_krw - b.cost_krw;
        return (sorting.direction === "asc" ? compared : -compared) || a.ordinal - b.ordinal;
      }),
    [rows, sorting],
  );
  const since = trendSince(data.since);
  const totals = rows.reduce(
    (sum, row) => ({
      requests: sum.requests + row.requests,
      tokens: sum.tokens + row.tokens,
      cost: sum.cost + row.cost_krw,
    }),
    { requests: 0, tokens: 0, cost: 0 },
  );
  const exportRows = (): void => {
    if (!isDataCurrent() || rows.length === 0) return;
    downloadCsv(
      `사용-추이-${range}`,
      toCsv(sorted, [
        { header: "구간 시작 (ISO 8601 UTC)", value: (row) => row.iso },
        {
          header: "집계 단위",
          value: (row) => (row.bucket === "hour" ? "시간" : row.bucket === "day" ? "일" : "확인 불가"),
        },
        { header: "요청 (건)", value: (row) => row.requests },
        { header: "토큰 (개)", value: (row) => row.tokens },
        { header: "비용 (KRW)", value: (row) => row.cost_krw },
      ]),
    );
  };
  return (
    <div className="overview-trend-data">
      <p className="obs-meta">
        집계 시작: {since ? <time dateTime={since}>{formatDateTime(since)}</time> : "확인 불가"} · 한국 시간
        (KST) · {data.bucket === "hour" ? "1시간" : data.bucket === "day" ? "1일" : "확인 불가"} 단위
      </p>
      <p className="obs-meta">
        시작·진행 중 구간은 일부 시간만 포함합니다. 기록이 없는 구간은 생략되며 그래프는 기록된 구간을
        시간순으로 연결합니다. 요일·시간대 활동과 보존 기록 표의 조회 범위는 별도입니다.
      </p>
      <dl className="overview-trend-totals" aria-label="수신 구간 합계">
        <div>
          <dt>요청</dt>
          <dd>{formatNumber(totals.requests)}건</dd>
        </div>
        <div>
          <dt>토큰</dt>
          <dd>{formatNumber(totals.tokens)}개</dd>
        </div>
        <div>
          <dt>비용</dt>
          <dd>{trendCost(totals.cost)}</dd>
        </div>
      </dl>
      <TimeSeriesChart
        caption={`${label} 요청 수`}
        scrollable
        externalTableId={tableId}
        series={[
          {
            id: "requests",
            name: "요청",
            colorVar: "--obs-series-1",
            points: rows.map((row) => ({ label: row.label, value: row.requests })),
          },
        ]}
        valueLabel="요청"
        format={formatPreciseNumber}
      />
      <TimeSeriesChart
        caption={`${label} 비용`}
        scrollable
        externalTableId={tableId}
        series={[
          {
            id: "cost",
            name: "비용",
            colorVar: "--obs-series-2",
            points: rows.map((row) => ({ label: row.label, value: row.cost_krw })),
          },
        ]}
        valueLabel="비용"
        format={trendCost}
      />
      <section aria-labelledby={tableId}>
        <div className="overview-trend-table-heading">
          <h3 id={tableId}>구간별 요청·토큰·비용</h3>
          <Button variant="secondary" disabled={rows.length === 0} onClick={exportRows}>
            <Download aria-hidden="true" />
            구간 CSV 내려받기
          </Button>
        </div>
        <p className="obs-meta">
          수신 {formatNumber(rows.length)}개 구간 · 정렬은 표와 CSV에 적용됩니다. 내보낸 시각은 UTC이며 비용은
          응답의 반올림 전 값을 사용합니다.
        </p>
        <DataTable
          caption={`${label} 구간별 요청·토큰·비용`}
          columns={columns}
          data={sorted}
          getRowId={(row) => String(row.ordinal)}
          sorting={{ value: sorting, onChange: setSorting, columns: sortable }}
          emptyMessage="이 기간에 기록된 구간이 없습니다. 조회 기간을 바꾸거나 새로고침하세요."
        />
      </section>
    </div>
  );
}
