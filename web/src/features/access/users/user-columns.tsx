import { managedRoleLabel } from "@/config/ui-labels";
import { formatSignedRatio, statusLabel, statusTone } from "@/features/access/access-format";
import type { AuthUserRow, UserSummary } from "@/shared/api/domains/access.schemas";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { formatDateTime, formatKRW, formatNumber, shortId } from "@/shared/utils/format";

export function accountColumns(
  teamNames: Readonly<Record<string, string>>,
  onEdit: (user: AuthUserRow, trigger: HTMLElement) => void,
  canWrite: boolean,
  writeDeniedReason: string,
): ReadonlyArray<DataTableColumn<AuthUserRow>> {
  const column = createDataTableColumnHelper<AuthUserRow>();
  return column.columns([
    column.accessor((row) => row.email, {
      id: "email",
      header: "이메일",
      cell: ({ row }) => (
        <div>
          <strong className="truncate">{row.original.email || "—"}</strong>
          <div className="access-list-detail mono">{shortId(row.original.id, 18)}</div>
        </div>
      ),
    }),
    column.accessor((row) => row.name, { id: "name", header: "이름" }),
    column.accessor((row) => row.role, {
      id: "role",
      header: "역할",
      cell: ({ getValue }) => (
        <Badge tone="info" title={getValue()}>
          {managedRoleLabel(getValue())}
        </Badge>
      ),
    }),
    column.accessor((row) => row.status, {
      id: "status",
      header: "상태",
      cell: ({ getValue }) => <Badge tone={statusTone(getValue())}>{statusLabel(getValue())}</Badge>,
    }),
    column.accessor((row) => row.team_id, {
      id: "team",
      header: "팀",
      cell: ({ getValue }) => teamNames[getValue()] ?? (getValue() || "—"),
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
        <div className="table-actions">
          <Button
            size="small"
            disabled={!canWrite || !row.original.id.startsWith("usr_")}
            title={
              !canWrite
                ? writeDeniedReason
                : row.original.id.startsWith("usr_")
                  ? undefined
                  : "SSO 등 외부에서 만들어진 계정은 이 화면에서 수정할 수 없습니다."
            }
            onClick={(event) => onEdit(row.original, event.currentTarget)}
          >
            역할·상태 변경
          </Button>
        </div>
      ),
    }),
  ]);
}

export function keyUsageColumns(
  onPromote: (row: UserSummary, trigger: HTMLElement) => void,
  canWrite: boolean,
  writeDeniedReason: string,
): ReadonlyArray<DataTableColumn<UserSummary>> {
  const column = createDataTableColumnHelper<UserSummary>();
  return column.columns([
    column.accessor((row) => row.name || row.api_key_id, {
      id: "name",
      header: "사용자 / 키",
      cell: ({ row }) => (
        <div>
          <strong className="truncate">{row.original.name || "이름 없음"}</strong>
          <div className="access-list-detail mono" title={row.original.api_key_id}>
            {shortId(row.original.api_key_id, 18)}
          </div>
        </div>
      ),
    }),
    column.accessor((row) => row.owner, { id: "owner", header: "소유자" }),
    column.accessor((row) => row.team, { id: "team", header: "팀" }),
    column.accessor((row) => row.status, {
      id: "status",
      header: "상태",
      cell: ({ row }) => (
        <div className="access-inline-actions">
          <Badge tone={statusTone(row.original.status)}>{statusLabel(row.original.status)}</Badge>
          {row.original.status === "external" ? (
            <Button
              size="small"
              disabled={!canWrite}
              title={canWrite ? undefined : writeDeniedReason}
              onClick={(event) => onPromote(row.original, event.currentTarget)}
            >
              관리 키로 등록
            </Button>
          ) : null}
        </div>
      ),
    }),
    column.accessor((row) => row.requests, {
      id: "requests",
      header: "요청",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.tokens, {
      id: "tokens",
      header: "토큰",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.cost_krw, {
      id: "cost",
      header: "비용",
      cell: ({ getValue }) => <span className="cell-number">{formatKRW(getValue())}</span>,
    }),
    column.accessor((row) => row.average_latency_ms, {
      id: "latency",
      header: "평균 지연",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}ms</span>,
    }),
    column.accessor((row) => row.last_seen, {
      id: "last_seen",
      header: "최근 사용",
      cell: ({ getValue }) => formatDateTime(getValue()),
    }),
  ]);
}

export function benchmarkColumns(): ReadonlyArray<
  DataTableColumn<{
    api_key_id: string;
    name: string;
    team: string;
    requests: number;
    sessions: number;
    active_days: number;
    commits: number;
    merged_mrs: number;
    tool_calls: number;
    success_rate: number;
    cost_krw: number;
    score: number;
  }>
> {
  const column = createDataTableColumnHelper<{
    api_key_id: string;
    name: string;
    team: string;
    requests: number;
    sessions: number;
    active_days: number;
    commits: number;
    merged_mrs: number;
    tool_calls: number;
    success_rate: number;
    cost_krw: number;
    score: number;
  }>();
  return column.columns([
    column.accessor((row) => row.name || row.api_key_id, { id: "name", header: "사용자" }),
    column.accessor((row) => row.team, { id: "team", header: "팀" }),
    column.accessor((row) => row.score, {
      id: "score",
      header: "점수",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue(), 1)}</span>,
    }),
    column.accessor((row) => row.requests, {
      id: "requests",
      header: "요청",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.sessions, {
      id: "sessions",
      header: "세션",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.active_days, {
      id: "active_days",
      header: "활동일",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.commits, {
      id: "commits",
      header: "커밋",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.merged_mrs, {
      id: "merged_mrs",
      header: "병합 MR",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.success_rate, {
      id: "success_rate",
      header: "성공률",
      cell: ({ getValue }) => <span className="cell-number">{formatSignedRatio(getValue())}</span>,
    }),
    column.accessor((row) => row.cost_krw, {
      id: "cost",
      header: "비용",
      cell: ({ getValue }) => <span className="cell-number">{formatKRW(getValue())}</span>,
    }),
  ]);
}
