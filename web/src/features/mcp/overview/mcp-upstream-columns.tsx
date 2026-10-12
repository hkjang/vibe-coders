import type { McpDiscoveryRun, McpRequest, McpFlowStep, McpUpstream } from "@/shared/api/domains/mcp.schemas";
import { detailText, riskTone, stepTone } from "@/features/mcp/mcp-utils";
import { Badge } from "@/shared/components/ui/Badge";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

const column = createDataTableColumnHelper<McpUpstream>();

export function upstreamColumns(
  discoveryErrors: Readonly<Record<string, string>>,
): ReadonlyArray<DataTableColumn<McpUpstream>> {
  return [
    column.accessor((row) => row.name, {
      id: "name",
      header: "이름",
      cell: (info) => (
        <div>
          <strong>{info.getValue<string>() || "—"}</strong>
          <div className="mono">{info.row.original.id}</div>
        </div>
      ),
    }),
    column.accessor((row) => row.url, {
      id: "url",
      header: "엔드포인트",
      cell: (info) => <span className="mono truncate">{info.getValue<string>() || "—"}</span>,
    }),
    column.accessor((row) => row.enabled, {
      id: "enabled",
      header: "상태",
      cell: (info) =>
        info.getValue<boolean>() ? <Badge tone="success">사용</Badge> : <Badge tone="muted">중지</Badge>,
    }),
    column.accessor((row) => row.has_auth, {
      id: "auth",
      header: "인증",
      cell: (info) => (info.getValue<boolean>() ? "토큰 설정됨" : "없음"),
    }),
    column.accessor((row) => row.metadata?.risk_level ?? "", {
      id: "risk",
      header: "위험도",
      cell: (info) =>
        info.getValue<string>() ? (
          <Badge tone={riskTone(info.getValue<string>())}>{info.getValue<string>()}</Badge>
        ) : (
          "—"
        ),
    }),
    column.accessor((row) => row.metadata?.requires_approval ?? false, {
      id: "approval",
      header: "승인 게이트",
      cell: (info) => (info.getValue<boolean>() ? "필요" : "—"),
    }),
    column.accessor((row) => discoveryErrors[row.name] ?? "", {
      id: "discovery",
      header: "디스커버리",
      cell: (info) =>
        info.getValue<string>() ? <Badge tone="danger">오류</Badge> : <Badge tone="success">정상</Badge>,
    }),
  ] as ReadonlyArray<DataTableColumn<McpUpstream>>;
}

const stepColumn = createDataTableColumnHelper<McpFlowStep>();
export const stepColumns = [
  stepColumn.accessor((row) => row.name, { id: "name", header: "단계" }),
  stepColumn.accessor((row) => detailText(row.status), {
    id: "status",
    header: "상태",
    cell: (info) => <Badge tone={stepTone(info.getValue<string>())}>{info.getValue<string>()}</Badge>,
  }),
  stepColumn.accessor((row) => detailText(row.detail), { id: "detail", header: "내용" }),
] as ReadonlyArray<DataTableColumn<McpFlowStep>>;

const runColumn = createDataTableColumnHelper<McpDiscoveryRun>();
export const runColumns = [
  runColumn.accessor((row) => formatDateTime(row.created_at), { id: "created_at", header: "시각" }),
  runColumn.accessor((row) => row.status, { id: "status", header: "상태" }),
  runColumn.accessor((row) => formatNumber(row.tool_count), { id: "tools", header: "도구" }),
  runColumn.accessor((row) => `${formatNumber(row.latency_ms)}ms`, { id: "latency", header: "지연" }),
  runColumn.accessor((row) => row.error || "—", { id: "error", header: "오류" }),
] as ReadonlyArray<DataTableColumn<McpDiscoveryRun>>;

const callColumn = createDataTableColumnHelper<McpRequest>();
export const callColumns = [
  callColumn.accessor((row) => formatDateTime(row.created_at), { id: "created_at", header: "시각" }),
  callColumn.accessor((row) => row.id, {
    id: "id",
    header: "요청 ID",
    cell: (info) => <span className="mono">{info.getValue<string>()}</span>,
  }),
  callColumn.accessor((row) => row.model || "—", { id: "model", header: "모델" }),
  callColumn.accessor((row) => formatNumber(row.status_code), { id: "status", header: "상태" }),
] as ReadonlyArray<DataTableColumn<McpRequest>>;
