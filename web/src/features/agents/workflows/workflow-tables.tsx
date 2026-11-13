import { useMemo } from "react";
import type { WorkflowRun } from "@/shared/api/domains/agents.schemas";
import type { WorkflowMetadata } from "@/shared/api/domains/workflow-page.schemas";
import { Badge } from "@/shared/components/ui/Badge";
import type { DataTableColumn } from "@/shared/data-table/columns";
import { displayColumn } from "@/features/agents/table-columns";
import { formatDateTime, formatDuration, formatNumber } from "@/shared/utils/format";
import { WorkflowDetailLink } from "./WorkflowDetailLink";
import { RunReceiptLink } from "../receipts/RunReceiptLink";
import { runState } from "../receipts/run-receipt";

export function useWorkflowColumns(
  workflows: readonly WorkflowMetadata[],
  onOpen?: (trigger: HTMLElement) => boolean,
  onReceiptOpen?: (trigger: HTMLElement) => void,
) {
  const columns = useMemo<ReadonlyArray<DataTableColumn<WorkflowMetadata>>>(
    () => [
      displayColumn<WorkflowMetadata>("name", "이름", (row) => (
        <WorkflowDetailLink row={row} onOpen={onOpen} />
      )),
      displayColumn<WorkflowMetadata>("steps", "단계", (row) => (
        <span className="cell-number">{formatNumber(row.step_count)}</span>
      )),
      displayColumn<WorkflowMetadata>("allowed_teams", "허용 팀", (row) => row.allowed_teams || "전체"),
      displayColumn<WorkflowMetadata>("enabled", "상태", (row) => (
        <Badge tone={row.enabled ? "success" : "muted"}>{row.enabled ? "사용" : "중지"}</Badge>
      )),
      displayColumn<WorkflowMetadata>("created_at", "생성일", (row) => formatDateTime(row.created_at)),
      displayColumn<WorkflowMetadata>("updated_at", "수정일", (row) => formatDateTime(row.updated_at)),
      displayColumn<WorkflowMetadata>("id", "ID", (row) => row.id),
    ],
    [onOpen],
  );
  const runColumns = useMemo<ReadonlyArray<DataTableColumn<WorkflowRun>>>(
    () => [
      displayColumn<WorkflowRun>("created_at", "실행 시각", (row) => formatDateTime(row.created_at)),
      displayColumn<WorkflowRun>(
        "workflow",
        "워크플로",
        (row) =>
          row.workflow_name ||
          workflows.find((workflow) => workflow.id === row.workflow_id)?.name ||
          row.workflow_id ||
          "—",
      ),
      displayColumn<WorkflowRun>("status", "상태", (row) => {
        const state = runState(row.status);
        return <Badge tone={state.tone}>{state.label}</Badge>;
      }),
      displayColumn<WorkflowRun>(
        "steps",
        "단계 성공",
        (row) => `${formatNumber(row.steps_ok ?? 0)}/${formatNumber(row.steps_total ?? 0)}`,
      ),
      displayColumn<WorkflowRun>("latency", "소요", (row) => (
        <span className="cell-number">{formatDuration(row.latency_ms ?? 0)}</span>
      )),
      displayColumn<WorkflowRun>("error", "오류 분류", (row) => row.error_class || "—"),
      displayColumn<WorkflowRun>("receipt", "영수증", (row) => (
        <RunReceiptLink id={row.id} resource="workflow" onOpen={onReceiptOpen} />
      )),
    ],
    [workflows, onReceiptOpen],
  );
  return { columns, runColumns };
}
