import type { RedTeamCampaign } from "@/shared/api/domains/redteam";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { formatKRW } from "@/shared/utils/format";
import {
  campaignScopeLabel,
  executionModeLabel,
  statusLabel,
  statusTone,
  writeDeniedReason,
} from "./redteam-ui";
interface CampaignActionHandlers {
  canWrite: boolean;
  writeReason?: string;
  checking: boolean;
  preflightTriggerRef: (id: string, node: HTMLButtonElement | null) => void;
  runTriggerRef: (id: string, node: HTMLButtonElement | null) => void;
  onApprove: (campaign: RedTeamCampaign) => void;
  onClone: (campaign: RedTeamCampaign, event: { currentTarget: HTMLElement }) => void;
  onDelete: (campaign: RedTeamCampaign, event: { currentTarget: HTMLElement }) => void;
  onDryRun: (campaign: RedTeamCampaign, event: { currentTarget: HTMLElement }) => void;
  onEdit: (campaign: RedTeamCampaign, event: { currentTarget: HTMLElement }) => void;
  onRun: (campaign: RedTeamCampaign, event: { currentTarget: HTMLElement }) => void;
}

export function campaignColumns(
  handlers: CampaignActionHandlers,
): ReadonlyArray<DataTableColumn<RedTeamCampaign>> {
  const column = createDataTableColumnHelper<RedTeamCampaign>();
  const writeTitle = handlers.canWrite ? undefined : (handlers.writeReason ?? writeDeniedReason);
  return column.columns([
    column.accessor((row) => row.name, {
      id: "name",
      header: "이름",
      cell: ({ row }) => (
        <div className="rt-stacked-cell">
          <strong>{row.original.name}</strong>
          <code className="mono">{row.original.id}</code>
        </div>
      ),
    }),
    column.accessor((row) => row.trigger_source, {
      id: "trigger",
      header: "생성 경로",
      cell: ({ row }) =>
        row.original.trigger_source === "post-change" ? (
          <div className="rt-stacked-cell">
            <Badge tone="info">변경 후 자동</Badge>
            <span title={row.original.trigger_reason || undefined}>{row.original.trigger_action || "—"}</span>
          </div>
        ) : (
          <span className="rt-muted">수동</span>
        ),
    }),
    column.accessor((row) => campaignScopeLabel(row.scope), { id: "scope", header: "범위" }),
    column.accessor((row) => row.status, {
      id: "status",
      header: "상태",
      cell: ({ getValue }) => <Badge tone={statusTone(getValue())}>{statusLabel(getValue())}</Badge>,
    }),
    column.accessor((row) => executionModeLabel(row.execution_mode), { id: "mode", header: "실행 방식" }),
    column.accessor((row) => row.budget_limit_krw, {
      id: "budget",
      header: "예산",
      cell: ({ getValue }) => <span className="cell-number">{formatKRW(getValue())}</span>,
    }),
    column.accessor((row) => row.retain_raw_evidence, {
      id: "evidence",
      header: "증적",
      cell: ({ getValue }) =>
        getValue() ? <Badge tone="warning">원문보관</Badge> : <span className="rt-muted">마스킹</span>,
    }),
    column.display({
      id: "actions",
      header: "작업",
      cell: ({ row }) => {
        const campaign = row.original;
        const automatic = campaign.trigger_source === "post-change";
        return (
          <div className="table-actions">
            <Button
              size="small"
              disabled={!handlers.canWrite || handlers.checking}
              title={writeTitle}
              aria-label={`${campaign.name} 사전 점검`}
              ref={(node) => handlers.preflightTriggerRef(campaign.id, node)}
              onClick={(event) => handlers.onDryRun(campaign, event)}
            >
              {handlers.checking ? "점검 중" : "사전 점검"}
            </Button>
            {automatic ? null : (
              <Button
                size="small"
                disabled={!handlers.canWrite}
                title={writeTitle}
                aria-label={`${campaign.name} 승인`}
                onClick={() => handlers.onApprove(campaign)}
              >
                승인
              </Button>
            )}
            <Button
              size="small"
              variant="primary"
              disabled={!handlers.canWrite}
              title={writeTitle}
              aria-label={`${campaign.name} ${campaign.execution_mode === "active-controlled" ? "실제 실행" : "시뮬레이션 실행"}`}
              ref={(node) => handlers.runTriggerRef(campaign.id, node)}
              onClick={(event) => handlers.onRun(campaign, event)}
            >
              {campaign.execution_mode === "active-controlled" ? "실제 실행" : "시뮬레이션 실행"}
            </Button>
            {automatic ? null : (
              <Button
                size="small"
                disabled={!handlers.canWrite}
                title={writeTitle}
                aria-label={`${campaign.name} 수정`}
                onClick={(event) => handlers.onEdit(campaign, event)}
              >
                수정
              </Button>
            )}
            <Button
              size="small"
              disabled={!handlers.canWrite}
              title={writeTitle}
              aria-label={`${campaign.name} 복제`}
              onClick={(event) => handlers.onClone(campaign, event)}
            >
              복제
            </Button>
            <Button
              size="small"
              variant="danger"
              disabled={!handlers.canWrite}
              title={writeTitle}
              aria-label={`${campaign.name} 삭제`}
              onClick={(event) => handlers.onDelete(campaign, event)}
            >
              삭제
            </Button>
          </div>
        );
      },
    }),
  ]);
}
