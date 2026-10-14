import { createContext, useContext } from "react";
import { riskLabel, riskTone } from "@/features/mcp/mcp-utils";
import type { McpContract } from "@/shared/api/domains/mcp.schemas";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { contractAddressableID } from "./contract-review";

interface Actions {
  writable: boolean;
  onEdit: (row: McpContract, trigger: HTMLButtonElement) => void;
  onDelete: (row: McpContract, trigger: HTMLButtonElement) => void;
}
const ActionContext = createContext<Actions | null>(null);
function RowActions({ row }: { row: McpContract }) {
  const actions = useContext(ActionContext);
  if (!actions) return null;
  const addressable = contractAddressableID(row.id);
  return (
    <div className="mcp-row-actions">
      <Button
        size="small"
        disabled={!actions.writable || !addressable}
        title={addressable ? undefined : "기존 API에서 ID가 달라질 수 있어 편집할 수 없습니다."}
        onClick={(event) => actions.onEdit(row, event.currentTarget)}
      >
        수정
      </Button>
      <Button
        size="small"
        variant="danger"
        disabled={!actions.writable || !addressable}
        title={addressable ? undefined : "기존 API에서 ID가 달라질 수 있어 삭제할 수 없습니다."}
        onClick={(event) => actions.onDelete(row, event.currentTarget)}
      >
        삭제
      </Button>
    </div>
  );
}
const column = createDataTableColumnHelper<McpContract>();
// Stable cell types preserve the actual trigger DOM across background refreshes.
const columns = [
  column.accessor((row) => row.name, { id: "name", header: "도구" }),
  column.accessor((row) => row.namespace, { id: "namespace", header: "네임스페이스" }),
  column.accessor((row) => row.risk_level, {
    id: "risk",
    header: "위험도",
    cell: (info) => (
      <Badge tone={riskTone(info.getValue<string>())}>{riskLabel(info.getValue<string>())}</Badge>
    ),
  }),
  column.accessor((row) => row.owner || "—", { id: "owner", header: "담당" }),
  column.accessor((row) => (row.enabled ? "사용" : "중지"), { id: "enabled", header: "상태" }),
  column.display({ id: "actions", header: "작업", cell: ({ row }) => <RowActions row={row.original} /> }),
] as ReadonlyArray<DataTableColumn<McpContract>>;
export function ContractTable({ data, ...actions }: Actions & { data: McpContract[] }) {
  return (
    <ActionContext.Provider value={actions}>
      <DataTable
        caption="MCP 도구 계약 레지스트리"
        columns={columns}
        data={data}
        getRowId={(row) => row.id}
      />
    </ActionContext.Provider>
  );
}
