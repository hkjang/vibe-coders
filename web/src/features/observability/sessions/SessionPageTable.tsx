import { createContext, useContext } from "react";
import type { SessionExplorerRow } from "@/shared/api/domains/session-page.schema";
import { Button } from "@/shared/components/ui/Button";
import { DataTable } from "@/shared/data-table/DataTable";
import { createDataTableColumnHelper } from "@/shared/data-table/columns";
import { formatDateTime, formatKRW, formatNumber } from "@/shared/utils/format";

const column = createDataTableColumnHelper<SessionExplorerRow>();
const ActionContext = createContext<{ busy: boolean; onOpen: (row: SessionExplorerRow) => void }>({
  busy: true,
  onOpen: () => undefined,
});
function SessionAction({ row }: { row: SessionExplorerRow }) {
  const action = useContext(ActionContext);
  return row.session_id ? (
    <Button
      variant="ghost"
      disabled={action.busy}
      onClick={() => action.onOpen(row)}
      aria-label={`${row.session_id} 세션 비행기록 열기`}
    >
      비행기록 보기
    </Button>
  ) : (
    "식별자 확인 필요"
  );
}
const columns = column.columns([
  column.display({
    id: "session",
    header: "세션 ID",
    cell: ({ row }) => <code>{row.original.session_id ?? "표시 불가"}</code>,
  }),
  column.display({
    id: "message",
    header: "마지막 메시지",
    cell: ({ row }) => (
      <span className="truncate" title={row.original.last_message}>
        {row.original.last_message || "미리보기 없음"}
      </span>
    ),
  }),
  column.display({
    id: "requests",
    header: "요청",
    cell: ({ row }) => formatNumber(row.original.requests),
  }),
  column.display({ id: "errors", header: "오류", cell: ({ row }) => formatNumber(row.original.errors) }),
  column.display({ id: "models", header: "모델 수", cell: ({ row }) => formatNumber(row.original.models) }),
  column.display({
    id: "tokens",
    header: "토큰",
    cell: ({ row }) => formatNumber(row.original.total_tokens),
  }),
  column.display({ id: "cost", header: "비용 (원)", cell: ({ row }) => formatKRW(row.original.cost_krw) }),
  column.display({
    id: "last",
    header: "마지막 활동",
    cell: ({ row }) => formatDateTime(row.original.last_seen),
  }),
  column.display({
    id: "detail",
    header: "상세",
    cell: ({ row }) => <SessionAction row={row.original} />,
  }),
]);
export function SessionPageTable({
  rows,
  loading,
  busy,
  onOpen,
}: {
  rows: readonly SessionExplorerRow[];
  loading: boolean;
  busy: boolean;
  onOpen: (row: SessionExplorerRow) => void;
}) {
  return (
    <ActionContext.Provider value={{ busy, onOpen }}>
      <DataTable
        caption="검색된 코딩 세션"
        columns={columns}
        data={rows}
        getRowId={(row) => row.row_key}
        loading={loading}
        tableId="session-explorer"
        lockedColumnIds={["session", "detail"]}
        emptyMessage="현재 페이지에 세션이 없습니다. 조회 조건을 확인하거나 첫 페이지로 이동하세요."
      />
    </ActionContext.Provider>
  );
}
