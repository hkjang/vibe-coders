import type { SessionSummary } from "@/shared/api/domains/observability.schemas";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { formatDateTime, formatKRW, formatNumber, formatRelative } from "@/shared/utils/format";
import { sessionResponseDays, type SessionListResult } from "./session-list-state";

const columns = ((): ReadonlyArray<DataTableColumn<SessionSummary>> => {
  const column = createDataTableColumnHelper<SessionSummary>();
  return column.columns([
    column.display({
      id: "session_id",
      header: "세션 ID",
      cell: ({ row }) => (
        <span className="mono truncate" title={row.original.session_id}>
          {row.original.session_id || "—"}
        </span>
      ),
    }),
    column.display({
      id: "last_message",
      header: "마지막 메시지",
      cell: ({ row }) => (
        <span className="truncate" title={row.original.last_message}>
          {row.original.last_message || "—"}
        </span>
      ),
    }),
    column.display({
      id: "requests",
      header: "요청",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.requests)}</span>,
    }),
    column.display({
      id: "errors",
      header: "오류",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.errors)}</span>,
    }),
    column.display({
      id: "models",
      header: "모델 수",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.models)}</span>,
    }),
    column.display({
      id: "total_tokens",
      header: "토큰",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.total_tokens)}</span>,
    }),
    column.display({
      id: "cost_krw",
      header: "비용",
      cell: ({ row }) => <span className="cell-number">{formatKRW(row.original.cost_krw)}</span>,
    }),
    column.display({
      id: "last_seen",
      header: "마지막 활동",
      cell: ({ row }) => (
        <span title={formatDateTime(row.original.last_seen)}>{formatRelative(row.original.last_seen)}</span>
      ),
    }),
  ]);
})();

export function SessionListResults({
  data,
  rows,
  pending,
  onOpen,
  onReset,
}: {
  data: SessionListResult | undefined;
  rows: readonly SessionSummary[];
  pending: boolean;
  onOpen: (row: SessionSummary) => void;
  onReset: () => void;
}) {
  const days = sessionResponseDays(data);
  const totals = rows.reduce(
    (sum, row) => ({
      requests: sum.requests + row.requests,
      errors: sum.errors + row.errors,
      cost: sum.cost + row.cost_krw,
    }),
    { requests: 0, errors: 0, cost: 0 },
  );
  return (
    <>
      {days !== undefined ? (
        <StatGrid label="세션 요약">
          <StatCard
            label="세션"
            value={formatNumber(rows.length)}
            hint={`응답 기준 최근 ${days}일 · 검색 적용`}
          />
          <StatCard label="요청" value={formatNumber(totals.requests)} />
          <StatCard
            label="오류"
            value={formatNumber(totals.errors)}
            tone={totals.errors > 0 ? "warning" : "default"}
          />
          <StatCard label="비용" value={formatKRW(totals.cost)} />
        </StatGrid>
      ) : null}
      <SectionCard title="최근 세션" description="검색과 합계는 불러온 최대 200개 세션에 적용됩니다.">
        {data && rows.length === 0 ? (
          <EmptyState
            title={
              data.response.sessions.length > 0
                ? "불러온 세션에서 검색 결과가 없습니다."
                : "표시할 세션이 없습니다."
            }
            description="현재 응답에서 표시할 세션이 없습니다. 전체 기록의 존재 여부나 전체 건수를 뜻하지 않습니다."
            actions={
              <Button onClick={onReset} variant="secondary">
                필터 초기화
              </Button>
            }
          />
        ) : (
          <DataTable
            caption="최근 코딩 세션"
            columns={columns}
            data={rows}
            getRowId={(row, index) => row.session_id || String(index)}
            loading={pending && !data}
            onRowClick={onOpen}
            getRowActionLabel={(row) => `${row.session_id} 세션 비행기록 열기`}
          />
        )}
      </SectionCard>
    </>
  );
}
