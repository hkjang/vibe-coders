import { statusLabel, statusTone } from "@/features/access/access-format";
import { ScopeBadges } from "@/features/access/access-ui";
import type { ApiKeyPublic } from "@/shared/api/domains/access.schemas";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { formatDateTime, shortId } from "@/shared/utils/format";

export function apiKeyColumns(
  onEdit: (row: ApiKeyPublic, trigger: HTMLElement) => void,
  onScopes: (row: ApiKeyPublic, trigger: HTMLElement) => void,
  onRevoke: (row: ApiKeyPublic, trigger: HTMLElement) => void,
  canWrite: boolean,
  writeDeniedReason: string,
  rememberScopeTrigger: (node: HTMLButtonElement | null, id: string) => void,
): ReadonlyArray<DataTableColumn<ApiKeyPublic>> {
  const column = createDataTableColumnHelper<ApiKeyPublic>();
  return column.columns([
    column.accessor((row) => row.name, {
      id: "name",
      header: "이름",
      cell: ({ row }) => (
        <div>
          <strong className="truncate">{row.original.name || "이름 없음"}</strong>
          <div className="access-list-detail mono" title={row.original.id}>
            {shortId(row.original.id, 18)}
          </div>
        </div>
      ),
    }),
    column.accessor((row) => row.owner, { id: "owner", header: "소유자" }),
    column.accessor((row) => row.team, { id: "team", header: "팀" }),
    column.accessor((row) => row.role, {
      id: "role",
      header: "역할",
      cell: ({ getValue }) => (getValue() ? <Badge tone="info">{getValue()}</Badge> : "—"),
    }),
    column.accessor((row) => row.status, {
      id: "status",
      header: "상태",
      cell: ({ getValue }) => <Badge tone={statusTone(getValue())}>{statusLabel(getValue())}</Badge>,
    }),
    column.accessor((row) => row.scopes.join(" "), {
      id: "scopes",
      header: "권한",
      cell: ({ row }) => <ScopeBadges scopes={row.original.scopes} />,
    }),
    column.accessor((row) => row.allowed_ips.join(" "), {
      id: "allowed_ips",
      header: "허용 IP",
      cell: ({ row }) =>
        row.original.allowed_ips.length === 0 ? (
          <span className="access-note">제한 없음</span>
        ) : (
          <span className="mono truncate">{row.original.allowed_ips.join(", ")}</span>
        ),
    }),
    column.accessor((row) => row.expires_at, {
      id: "expires_at",
      header: "만료",
      cell: ({ getValue }) => (getValue() ? formatDateTime(getValue()) : "무기한"),
    }),
    column.display({
      id: "actions",
      header: "작업",
      cell: ({ row }) => (
        <div className="table-actions">
          <Button
            size="small"
            disabled={!canWrite}
            title={canWrite ? undefined : writeDeniedReason}
            onClick={(event) => onEdit(row.original, event.currentTarget)}
          >
            수정
          </Button>
          <Button
            ref={(node) => rememberScopeTrigger(node, row.original.id)}
            size="small"
            disabled={!canWrite}
            title={canWrite ? undefined : writeDeniedReason}
            onClick={(event) => onScopes(row.original, event.currentTarget)}
          >
            권한 수정
          </Button>
          <Button
            size="small"
            variant="danger"
            disabled={!canWrite || row.original.status === "revoked"}
            title={canWrite ? undefined : writeDeniedReason}
            onClick={(event) => onRevoke(row.original, event.currentTarget)}
          >
            폐기
          </Button>
        </div>
      ),
    }),
  ]);
}
