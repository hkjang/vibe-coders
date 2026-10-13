import { keyDeadline, keyLifecycle } from "../key-lifecycle";
import { roleLabel } from "@/config/ui-labels";
import type { KeyRowAction } from "./use-key-row-focus";
import { ScopeBadges } from "@/features/access/access-ui";
import type { ApiKeyPublic } from "@/shared/api/domains/access.schemas";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { formatDateTime, shortId } from "@/shared/utils/format";

interface KeyActionsMetadata {
  renderActions: (row: ApiKeyPublic) => React.ReactNode;
}

// Keep the cell component identity stable while refreshing its handlers through
// column metadata. Otherwise a query update can detach a pressed/focused button.
function renderKeyActions({
  row,
  column,
}: {
  row: { original: ApiKeyPublic };
  column: { columnDef: { meta?: unknown } };
}): React.ReactNode {
  return (column.columnDef.meta as KeyActionsMetadata).renderActions(row.original);
}

export function apiKeyColumns(
  onEdit: (row: ApiKeyPublic, trigger: HTMLElement) => void,
  onScopes: (row: ApiKeyPublic, trigger: HTMLElement) => void,
  onRevoke: (row: ApiKeyPublic, trigger: HTMLElement) => void,
  canWrite: boolean,
  writeDeniedReason: string,
  rememberScopeTrigger: (node: HTMLButtonElement | null, id: string) => void,
  revokeAttempts: ReadonlySet<string> = new Set(),
  now: number = Date.now(),
  rememberRowTrigger?: (node: HTMLButtonElement | null, id: string, action: KeyRowAction) => void,
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
      cell: ({ getValue }) => (getValue() ? <Badge tone="info">{roleLabel(getValue())}</Badge> : "—"),
    }),
    column.accessor((row) => keyLifecycle(row, now).label, {
      id: "status",
      header: "상태",
      cell: ({ row, getValue }) => <Badge tone={keyLifecycle(row.original, now).tone}>{getValue()}</Badge>,
    }),
    column.accessor((row) => row.scopes.join(" "), {
      id: "scopes",
      header: "권한",
      cell: ({ row }) =>
        row.original.scopes.length === 0 ? (
          <span className="access-note">선택된 권한 없음</span>
        ) : (
          <ScopeBadges scopes={row.original.scopes} />
        ),
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
    column.accessor((row) => keyDeadline(row), {
      id: "expires_at",
      header: "만료·유예 종료",
      cell: ({ getValue }) =>
        Number.isNaN(getValue())
          ? "시각 확인 필요"
          : Number.isFinite(getValue())
            ? formatDateTime(new Date(getValue()).toISOString())
            : "무기한",
    }),
    column.display({
      id: "actions",
      header: "작업",
      cell: renderKeyActions,
      meta: {
        renderActions: (key: ApiKeyPublic) => (
          <div className="table-actions access-key-actions">
            <Button
              ref={(node) => rememberRowTrigger?.(node, key.id, "edit")}
              size="small"
              disabled={!canWrite}
              title={canWrite ? undefined : writeDeniedReason}
              onClick={(event) => onEdit(key, event.currentTarget)}
            >
              수정
            </Button>
            <Button
              ref={(node) => rememberScopeTrigger(node, key.id)}
              size="small"
              disabled={!canWrite}
              title={canWrite ? undefined : writeDeniedReason}
              onClick={(event) => onScopes(key, event.currentTarget)}
            >
              권한 수정
            </Button>
            <Button
              ref={(node) => rememberRowTrigger?.(node, key.id, "revoke")}
              size="small"
              variant="danger"
              disabled={!canWrite || key.status === "revoked" || revokeAttempts.has(key.id)}
              title={canWrite ? undefined : writeDeniedReason}
              onClick={(event) => onRevoke(key, event.currentTarget)}
            >
              폐기
            </Button>
          </div>
        ),
      } satisfies KeyActionsMetadata,
    }),
  ]);
}
