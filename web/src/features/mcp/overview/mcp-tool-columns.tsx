import type { McpToolRisk } from "@/shared/api/domains/mcp.schemas";
import { decisionLabel, riskLabel, riskTone } from "@/features/mcp/mcp-utils";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { formatDateTime, formatNumber, formatPercent } from "@/shared/utils/format";

export interface ToolRow extends McpToolRisk {
  calls: number;
  errors: number;
  errorRate: number;
  lastSeen: string;
}

const toolColumn = createDataTableColumnHelper<ToolRow>();

export function toolColumns(
  canWrite: boolean,
  onEdit: (row: ToolRow, trigger: HTMLElement) => void,
): ReadonlyArray<DataTableColumn<ToolRow>> {
  return [
    toolColumn.accessor((row) => row.server_label, { id: "server", header: "서버" }),
    toolColumn.accessor((row) => row.tool_name, {
      id: "tool",
      header: "도구",
      cell: (info) => <span className="mono">{info.getValue<string>()}</span>,
    }),
    toolColumn.accessor((row) => row.access_class, { id: "class", header: "접근 유형" }),
    toolColumn.accessor((row) => row.risk_level, {
      id: "risk",
      header: "위험도",
      cell: (info) => (
        <Badge tone={riskTone(info.getValue<string>())}>{riskLabel(info.getValue<string>())}</Badge>
      ),
    }),
    toolColumn.accessor((row) => row.action, {
      id: "action",
      header: "조치",
      cell: (info) => (
        <Badge tone={info.getValue<string>() === "block" ? "danger" : "muted"}>
          {decisionLabel(info.getValue<string>())}
        </Badge>
      ),
    }),
    toolColumn.accessor((row) => (row.configured ? "설정됨" : "기본값"), {
      id: "configured",
      header: "설정 상태",
    }),
    toolColumn.accessor((row) => row.calls, {
      id: "calls",
      header: "호출",
      cell: (info) => <span className="cell-number">{formatNumber(info.getValue<number>())}</span>,
    }),
    toolColumn.accessor((row) => row.errorRate, {
      id: "errorRate",
      header: "오류율",
      cell: (info) => <span className="cell-number">{formatPercent(info.getValue<number>())}</span>,
    }),
    toolColumn.accessor((row) => row.lastSeen, {
      id: "lastSeen",
      header: "최근 호출",
      cell: (info) => formatDateTime(info.getValue<string>()),
    }),
    toolColumn.display({
      id: "actions",
      header: "작업",
      cell: (info) => (
        <Button
          size="small"
          variant="ghost"
          disabled={!canWrite}
          title={canWrite ? undefined : "mcp:admin 권한이 필요합니다."}
          aria-label={`${info.row.original.server_label} ${info.row.original.tool_name} 위험 등급 편집`}
          onClick={(event) => onEdit(info.row.original, event.currentTarget)}
        >
          위험 등급 편집
        </Button>
      ),
    }),
  ] as ReadonlyArray<DataTableColumn<ToolRow>>;
}

interface ServerRow {
  server_label: string;
  is_mcp: boolean;
  tools: number;
  calls: number;
  errors: number;
  error_rate: number;
  distinct_keys: number;
  last_seen: string;
}
const serverColumn = createDataTableColumnHelper<ServerRow>();
export const serverColumns = [
  serverColumn.accessor((row) => row.server_label, { id: "server", header: "서버" }),
  serverColumn.accessor((row) => (row.is_mcp ? "MCP" : "일반 도구"), { id: "kind", header: "유형" }),
  serverColumn.accessor((row) => formatNumber(row.tools), { id: "tools", header: "도구 수" }),
  serverColumn.accessor((row) => formatNumber(row.calls), { id: "calls", header: "호출" }),
  serverColumn.accessor((row) => formatNumber(row.errors), { id: "errors", header: "오류" }),
  serverColumn.accessor((row) => formatPercent(row.error_rate), { id: "rate", header: "오류율" }),
  serverColumn.accessor((row) => formatNumber(row.distinct_keys), { id: "keys", header: "사용 키" }),
  serverColumn.accessor((row) => formatDateTime(row.last_seen), { id: "last", header: "최근" }),
] as ReadonlyArray<DataTableColumn<ServerRow>>;

interface CatalogRow {
  server_label: string;
  tool_name: string;
  first_seen: string;
  last_seen: string;
  is_new: boolean;
  is_stale: boolean;
}
const catalogColumn = createDataTableColumnHelper<CatalogRow>();
export const catalogColumns = [
  catalogColumn.accessor((row) => row.server_label, { id: "server", header: "서버" }),
  catalogColumn.accessor((row) => row.tool_name, {
    id: "tool",
    header: "도구",
    cell: (info) => <span className="mono">{info.getValue<string>()}</span>,
  }),
  catalogColumn.accessor((row) => (row.is_new ? "신규" : row.is_stale ? "유휴" : "정상"), {
    id: "state",
    header: "상태",
    cell: (info) => {
      const label = info.getValue<string>();
      return (
        <Badge tone={label === "신규" ? "warning" : label === "유휴" ? "muted" : "success"}>{label}</Badge>
      );
    },
  }),
  catalogColumn.accessor((row) => formatDateTime(row.first_seen), { id: "first", header: "최초 관측" }),
  catalogColumn.accessor((row) => formatDateTime(row.last_seen), { id: "last", header: "최근 관측" }),
] as ReadonlyArray<DataTableColumn<CatalogRow>>;

interface TrustRow {
  ref: string;
  trust_score: number;
  grade: string;
  risk_level: string;
  calls: number;
  error_rate_pct: number;
  confidence: string;
}
const trustColumn = createDataTableColumnHelper<TrustRow>();
export const trustColumns = [
  trustColumn.accessor((row) => row.ref, {
    id: "ref",
    header: "서버/도구",
    cell: (info) => <span className="mono">{info.getValue<string>()}</span>,
  }),
  trustColumn.accessor((row) => row.trust_score, {
    id: "score",
    header: "신뢰 점수",
    cell: (info) => <span className="cell-number">{formatNumber(info.getValue<number>(), 1)}</span>,
  }),
  trustColumn.accessor((row) => row.grade, {
    id: "grade",
    header: "등급",
    cell: (info) => {
      const grade = info.getValue<string>();
      return <Badge tone={grade === "A" ? "success" : grade === "D" ? "danger" : "warning"}>{grade}</Badge>;
    },
  }),
  trustColumn.accessor((row) => row.risk_level, {
    id: "risk",
    header: "위험도",
    cell: (info) => riskLabel(info.getValue<string>()),
  }),
  trustColumn.accessor((row) => formatNumber(row.calls), { id: "calls", header: "호출" }),
  trustColumn.accessor((row) => `${formatNumber(row.error_rate_pct, 1)}%`, {
    id: "rate",
    header: "오류율",
  }),
  trustColumn.accessor((row) => (row.confidence === "low" ? "표본 부족" : "충분"), {
    id: "confidence",
    header: "표본",
  }),
] as ReadonlyArray<DataTableColumn<TrustRow>>;
