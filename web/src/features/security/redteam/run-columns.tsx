import { Link } from "react-router";
import type { RedTeamRun } from "@/shared/api/domains/redteam";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { formatNumber, formatRelative } from "@/shared/utils/format";
import { statusTone, statusLabel, scoreTone, executionModeLabel } from "./redteam-ui";
export function runColumns(
  onOpen: (run: RedTeamRun, event: { currentTarget: HTMLElement }) => void,
  expanded = false,
  detailHref?: (id: string) => string,
): ReadonlyArray<DataTableColumn<RedTeamRun>> {
  const column = createDataTableColumnHelper<RedTeamRun>();
  return column.columns([
    column.accessor((row) => row.id, {
      id: "id",
      header: "실행",
      size: expanded ? 270 : undefined,
      cell: ({ row }) => (
        <div className="rt-stacked-cell">
          {detailHref ? (
            <Link
              to={detailHref(row.original.id)}
              className="rt-run-id-link"
              aria-label={`${row.original.id} 실행 상세`}
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                  return;
                event.preventDefault();
                onOpen(row.original, event);
              }}
            >
              <code>{row.original.id}</code>
            </Link>
          ) : (
            <code className="mono">{row.original.id}</code>
          )}
          {row.original.source_result_id ? (
            <span>
              한 건 재실행 · 원본 <code>{row.original.source_result_id}</code>
            </span>
          ) : null}
          <span title={row.original.created_at || undefined}>
            {formatRelative(row.original.created_at || null)}
          </span>
        </div>
      ),
    }),
    column.accessor((row) => row.campaign_id, {
      id: "campaign_id",
      header: "캠페인",
      cell: ({ getValue }) => <code className="mono">{getValue()}</code>,
    }),
    column.accessor((row) => row.target_id, {
      id: "target_id",
      header: "대상",
      cell: ({ getValue }) => <code className="mono">{getValue()}</code>,
    }),
    column.accessor((row) => row.status, {
      id: "status",
      header: "상태",
      cell: ({ getValue }) => <Badge tone={statusTone(getValue())}>{statusLabel(getValue())}</Badge>,
    }),
    column.accessor((row) => row.failed_cases, {
      id: expanded ? "failed_cases" : "cases",
      header: "실패/전체",
      cell: ({ row }) => (
        <span className="cell-number">
          {formatNumber(row.original.failed_cases)} / {formatNumber(row.original.total_cases)}
        </span>
      ),
    }),
    column.accessor((row) => row.risk_score, {
      id: "risk_score",
      header: "위험",
      cell: ({ getValue }) => <Badge tone={scoreTone(getValue())}>{formatNumber(getValue())}</Badge>,
    }),
    ...(expanded
      ? [
          column.accessor((row) => row.total_cases, {
            id: "total_cases",
            header: "전체 검사(건)",
            cell: ({ getValue }) => formatNumber(getValue()),
          }),
          column.accessor((row) => row.created_at, {
            id: "created_at",
            header: "실행 시각",
            size: 170,
            cell: ({ getValue }) => (
              <time dateTime={getValue()} title={getValue()}>
                {formatRelative(getValue() || null)}
              </time>
            ),
          }),
          column.accessor((row) => row.mode, {
            id: "mode",
            header: "실행 방식",
            size: 150,
            cell: ({ getValue }) => executionModeLabel(getValue()),
          }),
          column.accessor((row) => row.cost_krw, {
            id: "cost_krw",
            header: "비용(원)",
            size: 110,
            cell: ({ getValue }) => formatNumber(getValue()),
          }),
        ]
      : []),
    column.display({
      id: "actions",
      header: "작업",
      cell: ({ row }) => (
        <Button
          size="small"
          aria-label={`${row.original.id} 결과 보기`}
          onClick={(event) => onOpen(row.original, event)}
        >
          결과
        </Button>
      ),
    }),
  ]);
}
