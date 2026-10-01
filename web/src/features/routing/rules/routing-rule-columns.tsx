import { useMemo } from "react";
import type { RoutingRule } from "@/shared/api/domains/routing";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { formatDateTime } from "@/shared/utils/format";
import { writeScopeMessage } from "./routing-shared";
import { toggleIdentityReason } from "./routing-toggle-state";
import { editIdentityReason, ruleText } from "./routing-rule-edit-state";

/** How a rule is named in confirmations and accessible action labels. */
function ruleLabel(rule: RoutingRule, prefixes: readonly string[]): string {
  return `${ruleText(rule.match_pattern, prefixes, "*")} → ${ruleText(rule.target_model, prefixes)}`;
}

interface RuleRowActions {
  onDelete: (rule: RoutingRule, trigger: HTMLButtonElement) => void;
  onEdit: (rule: RoutingRule, trigger: HTMLButtonElement) => void;
  onEditRef?: (id: string, button: HTMLButtonElement | null) => void;
  onToggle: (rule: RoutingRule, trigger: HTMLButtonElement) => void;
  onToggleRef: (id: string, button: HTMLButtonElement | null) => void;
}

export function useRuleColumns(
  canWrite: boolean,
  actions: RuleRowActions,
  toggle: { allowed: boolean; reason?: string },
  edit?: { allowed: boolean; reason?: string; prefixes: readonly string[] },
): ReadonlyArray<DataTableColumn<RoutingRule>> {
  return useMemo(() => {
    const column = createDataTableColumnHelper<RoutingRule>();
    const prefixes = edit?.prefixes ?? [];
    return column.columns([
      column.accessor((row) => row.priority, {
        id: "priority",
        header: "우선순위",
        cell: ({ getValue }) => <span className="cell-number">{getValue()}</span>,
      }),
      column.accessor((row) => row.match_pattern, {
        id: "match_pattern",
        header: "모델 패턴",
        cell: ({ getValue }) => <span className="mono">{ruleText(getValue(), prefixes, "*")}</span>,
      }),
      column.accessor((row) => `${row.min_complexity}–${row.max_complexity}`, {
        id: "complexity",
        header: "복잡도 범위",
        cell: ({ getValue }) => <span className="cell-number">{getValue()}</span>,
      }),
      column.accessor((row) => row.target_model, {
        id: "target_model",
        header: "대상 모델",
        cell: ({ getValue }) => <span className="mono">{ruleText(getValue(), prefixes)}</span>,
      }),
      column.accessor((row) => row.target_provider, {
        id: "target_provider",
        header: "대상 공급자",
        cell: ({ getValue }) => ruleText(getValue(), prefixes, "자동 선택"),
      }),
      column.accessor((row) => row.enabled, {
        id: "enabled",
        header: "상태",
        cell: ({ getValue }) =>
          getValue() ? <Badge tone="success">사용 중</Badge> : <Badge tone="muted">중지됨</Badge>,
      }),
      column.accessor((row) => row.note, {
        id: "note",
        header: "메모",
        cell: ({ getValue }) => (
          <span className="truncate" title={ruleText(getValue(), prefixes, "")}>
            {ruleText(getValue(), prefixes, "—")}
          </span>
        ),
      }),
      column.accessor((row) => row.created_at, {
        id: "created_at",
        header: "생성",
        cell: ({ getValue }) => formatDateTime(getValue()),
      }),
      column.display({
        id: "actions",
        header: "작업",
        cell: ({ row }) => (
          <div className="routing-tab-actions">
            <Button
              ref={(button) => actions.onToggleRef(row.original.id, button)}
              size="small"
              variant="ghost"
              aria-label={`${ruleLabel(row.original, prefixes)} 규칙 ${row.original.enabled ? "중지" : "사용"}`}
              disabled={!toggle.allowed || !!toggleIdentityReason(row.original.id)}
              title={toggleIdentityReason(row.original.id) ?? toggle.reason}
              onClick={(event) => actions.onToggle(row.original, event.currentTarget)}
            >
              {row.original.enabled ? "중지" : "사용"}
            </Button>
            <Button
              ref={(button) => actions.onEditRef?.(row.original.id, button)}
              size="small"
              variant="ghost"
              aria-label={`${ruleLabel(row.original, prefixes)} 규칙 수정`}
              disabled={!(edit?.allowed ?? canWrite) || !!editIdentityReason(row.original)}
              title={
                editIdentityReason(row.original) ?? edit?.reason ?? (canWrite ? undefined : writeScopeMessage)
              }
              onClick={(event) => actions.onEdit(row.original, event.currentTarget)}
            >
              수정
            </Button>
            <Button
              size="small"
              variant="ghost"
              aria-label={`${ruleLabel(row.original, prefixes)} 규칙 삭제`}
              disabled={!canWrite}
              title={canWrite ? undefined : writeScopeMessage}
              onClick={(event) => actions.onDelete(row.original, event.currentTarget)}
            >
              삭제
            </Button>
          </div>
        ),
      }),
    ]);
  }, [canWrite, actions, toggle, edit]);
}
