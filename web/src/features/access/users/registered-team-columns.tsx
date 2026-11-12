import type { AuthTeamRow } from "@/shared/api/domains/access.schemas";
import { Button } from "@/shared/components/ui/Button";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { formatDateTime } from "@/shared/utils/format";
import { RegisteredTeamLink } from "./RegisteredTeamLink";

export function registeredTeamColumns(
  onEdit: (row: AuthTeamRow, trigger: HTMLElement) => void,
  onOpen: (trigger: HTMLElement) => boolean,
  canEdit: (row: AuthTeamRow) => boolean,
  protectedId: (id: string) => boolean,
): ReadonlyArray<DataTableColumn<AuthTeamRow>> {
  const column = createDataTableColumnHelper<AuthTeamRow>();
  return column.columns([
    column.accessor((row) => row.name, {
      id: "name",
      header: "팀 이름",
      cell: ({ row }) => <RegisteredTeamLink row={row.original} onOpen={onOpen} />,
    }),
    column.accessor((row) => row.id, {
      id: "id",
      header: "팀 ID",
      cell: ({ getValue }) => (
        <span className="mono">{protectedId(getValue()) ? "보호된 팀 ID" : getValue()}</span>
      ),
    }),
    column.accessor((row) => row.created_at, {
      id: "created_at",
      header: "생성",
      cell: ({ getValue }) => formatDateTime(getValue()),
    }),
    column.accessor((row) => row.updated_at, {
      id: "updated_at",
      header: "수정",
      cell: ({ getValue }) => formatDateTime(getValue()),
    }),
    column.display({
      id: "actions",
      header: "작업",
      cell: ({ row }) => (
        <Button
          size="small"
          disabled={!canEdit(row.original)}
          title={protectedId(row.original.id) ? "ID 표시 보호 정책에 따라 수정할 수 없습니다." : undefined}
          onClick={(event) => onEdit(row.original, event.currentTarget)}
        >
          이름 수정
        </Button>
      ),
    }),
  ]);
}
