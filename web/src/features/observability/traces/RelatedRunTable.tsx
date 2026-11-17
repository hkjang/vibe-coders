import { Link } from "react-router";
import { useAuth } from "@/app/auth/AuthProvider";
import { featureByPath, resolveFeature } from "@/config/migration-registry";
import { runState, validReceiptId } from "@/features/agents/receipts/run-receipt";
import type { TraceRelatedRun } from "@/shared/api/domains/trace-related-runs.schema";
import { DataTable } from "@/shared/data-table/DataTable";
import { createDataTableColumnHelper } from "@/shared/data-table/columns";
import { Badge } from "@/shared/components/ui/Badge";
import { formatDateTime, formatDuration, formatKRW } from "@/shared/utils/format";

const column = createDataTableColumnHelper<TraceRelatedRun>();
export function RelatedRunTable({
  kind,
  rows,
  loading,
}: {
  kind: "workflow" | "app";
  rows: readonly TraceRelatedRun[];
  loading: boolean;
}) {
  const auth = useAuth();
  const path = kind === "workflow" ? "/app/agents/workflows" : "/app/agents/apps";
  const feature = featureByPath(path, auth.features) ?? featureByPath(path);
  const access = feature
    ? resolveFeature(feature, auth.user, auth.backendVersion, { legacyFallback: auth.legacyFallback })
    : undefined;
  const permitted = access?.permitted && access.status !== "legacy" && access.status !== "hidden";
  const safe = (value: string | null) =>
    value && value.trim() === value && validReceiptId(value, auth.credentialPrefixes) ? value : null;
  const columns = [
    column.display({
      id: "name",
      header: kind === "workflow" ? "워크플로" : "앱",
      cell: ({ row }) => safe(row.original.resource_name) ?? "이름 표시 불가",
    }),
    column.display({
      id: "run",
      header: "실행 ID",
      cell: ({ row }) => <code>{safe(row.original.id) ?? "표시 불가"}</code>,
    }),
    column.display({
      id: "status",
      header: "상태",
      cell: ({ row }) => {
        const state = runState(row.original.status);
        return <Badge tone={state.tone}>{state.label}</Badge>;
      },
    }),
    column.display({
      id: "time",
      header: "기록 시각",
      cell: ({ row }) => formatDateTime(row.original.created_at),
    }),
    column.display({
      id: "latency",
      header: "지연",
      cell: ({ row }) => formatDuration(row.original.latency_ms),
    }),
    column.display({ id: "cost", header: "비용 (원)", cell: ({ row }) => formatKRW(row.original.cost_krw) }),
    column.display({
      id: "links",
      header: "상세",
      cell: ({ row }) => {
        const item = row.original;
        const resource = safe(item.resource_id);
        const run = safe(item.id);
        if (!permitted) return "화면 권한 확인 필요";
        const destination = path.slice(4);
        return (
          <div className="trace-related-links">
            {resource ? (
              <Link to={`${destination}?${new URLSearchParams({ [kind]: resource })}`}>정의 보기</Link>
            ) : null}
            {run && item.receipt_available ? (
              <Link to={`${destination}?${new URLSearchParams({ tab: "runs", run })}`}>내 실행 영수증</Link>
            ) : null}
            {!resource && !(run && item.receipt_available) ? "연결 가능한 상세 없음" : null}
          </div>
        );
      },
    }),
  ];
  return (
    <DataTable
      caption={kind === "workflow" ? "연관 워크플로 실행" : "연관 앱 실행"}
      columns={columns}
      data={rows}
      loading={loading}
      getRowId={(row) => row.row_key}
      tableId={`trace-related-${kind}`}
      lockedColumnIds={["run"]}
      emptyMessage="현재 페이지에 연관 실행이 없습니다. 추적 ID와 실행 종류를 확인하세요."
    />
  );
}
