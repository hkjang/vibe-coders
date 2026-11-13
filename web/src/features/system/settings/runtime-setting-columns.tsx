import { SettingKeyLink } from "./SettingKeyLink";
import type { EffectiveSetting } from "@/shared/api/domains/system.schemas";
import { Badge } from "@/shared/components/ui/Badge";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { formatDateTime } from "@/shared/utils/format";
import { settingDisplayValue, settingSourceLabel } from "./settings-utils";

function createSettingColumns(): ReadonlyArray<DataTableColumn<EffectiveSetting>> {
  const column = createDataTableColumnHelper<EffectiveSetting>();
  return column.columns([
    column.accessor((row) => row.key, {
      id: "key",
      header: "설정 키",
      cell: ({ row }) => (
        <div className="settings-key-cell">
          <SettingKeyLink settingKey={row.original.key} />
          {row.original.description ? <small>{row.original.description}</small> : null}
        </div>
      ),
    }),
    column.accessor((row) => row.category, { id: "category", header: "범주" }),
    column.accessor((row) => settingDisplayValue(row), {
      id: "value",
      header: "현재 값",
      cell: ({ row }) => <span className="mono truncate">{settingDisplayValue(row.original)}</span>,
    }),
    column.accessor((row) => settingSourceLabel(row.source), { id: "source", header: "적용 출처" }),
    column.display({
      id: "flags",
      header: "상태",
      cell: ({ row }) => (
        <span className="badge-list">
          {row.original.read_only ? <Badge tone="muted">읽기 전용</Badge> : null}
          {row.original.restart_required ? <Badge tone="warning">재시작 필요</Badge> : null}
          {row.original.is_secret ? <Badge tone="info">비밀값</Badge> : null}
        </span>
      ),
    }),
    column.accessor((row) => row.updated_at ?? "", {
      id: "updated_at",
      header: "마지막 변경",
      cell: ({ row }) => formatDateTime(row.original.updated_at),
    }),
  ]);
}

export const settingColumns = createSettingColumns();
