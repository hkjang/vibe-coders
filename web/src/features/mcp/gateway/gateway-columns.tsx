import { riskLabel, riskTone } from "@/features/mcp/mcp-utils";
import { Badge } from "@/shared/components/ui/Badge";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { formatNumber } from "@/shared/utils/format";
import { validationLabel } from "./contract-review";

interface GatewayToolRow {
  name: string;
  description: string;
}
const toolColumn = createDataTableColumnHelper<GatewayToolRow>();
export const toolColumns = [
  toolColumn.accessor((row) => row.name, {
    id: "name",
    header: "도구",
    cell: (info) => <span className="mono">{info.getValue<string>()}</span>,
  }),
  toolColumn.accessor((row) => row.description || "—", { id: "description", header: "설명" }),
] as ReadonlyArray<DataTableColumn<GatewayToolRow>>;

interface GatewayContractRow {
  name: string;
  risk_level: string;
  cost_policy: string;
  timeout_ms: number;
  allowed_roles: string;
  executes: boolean;
  output_schema: string;
}
const publishedColumn = createDataTableColumnHelper<GatewayContractRow>();
export const publishedColumns = [
  publishedColumn.accessor((row) => row.name, {
    id: "name",
    header: "도구",
    cell: (info) => <span className="mono">{info.getValue<string>()}</span>,
  }),
  publishedColumn.accessor((row) => row.risk_level, {
    id: "risk",
    header: "위험도",
    cell: (info) => (
      <Badge tone={riskTone(info.getValue<string>())}>{riskLabel(info.getValue<string>())}</Badge>
    ),
  }),
  publishedColumn.accessor((row) => row.cost_policy, { id: "cost", header: "비용 정책" }),
  publishedColumn.accessor((row) => `${formatNumber(row.timeout_ms)}ms`, {
    id: "timeout",
    header: "타임아웃",
  }),
  publishedColumn.accessor((row) => (row.executes ? "실행" : "읽기 전용"), {
    id: "executes",
    header: "동작",
  }),
  publishedColumn.accessor((row) => row.output_schema, { id: "output", header: "출력 형태" }),
] as ReadonlyArray<DataTableColumn<GatewayContractRow>>;

interface ValidationRow {
  contract_id: string;
  namespace: string;
  name: string;
  status: string;
  detail: string;
  declared_only: string[];
  live_only: string[];
}
const validationColumn = createDataTableColumnHelper<ValidationRow>();
export const validationColumns = [
  validationColumn.accessor((row) => row.name, {
    id: "name",
    header: "도구",
    cell: (info) => <span className="mono">{info.getValue<string>()}</span>,
  }),
  validationColumn.accessor((row) => row.namespace, { id: "namespace", header: "네임스페이스" }),
  validationColumn.accessor((row) => row.status, {
    id: "status",
    header: "결과",
    cell: (info) => {
      const status = info.getValue<string>();
      return (
        <Badge tone={status === "ok" ? "success" : status === "missing" ? "danger" : "warning"}>
          {validationLabel(status)}
        </Badge>
      );
    },
  }),
  validationColumn.accessor((row) => row.detail, { id: "detail", header: "설명" }),
  validationColumn.accessor(
    (row) =>
      [
        row.declared_only.length > 0 ? `계약에만: ${row.declared_only.join(", ")}` : "",
        row.live_only.length > 0 ? `실제에만: ${row.live_only.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" / ") || "—",
    { id: "diff", header: "스키마 차이" },
  ),
] as ReadonlyArray<DataTableColumn<ValidationRow>>;
