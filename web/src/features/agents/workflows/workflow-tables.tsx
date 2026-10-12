import { useMemo } from "react";
import type { Workflow, WorkflowRun } from "@/shared/api/domains/agents.schemas";
import { Badge } from "@/shared/components/ui/Badge";
import type { DataTableColumn } from "@/shared/data-table/columns";
import { displayColumn } from "@/features/agents/table-columns";
import { formatDateTime, formatDuration, formatNumber } from "@/shared/utils/format";

const states = {
  ok: { label: "완료", tone: "success" },
  error: { label: "오류", tone: "danger" },
  pending_approval: { label: "승인 대기", tone: "warning" },
  planned: { label: "계획됨", tone: "info" },
} as const;

export function useWorkflowColumns(workflows: readonly Workflow[]) {
  const columns = useMemo<ReadonlyArray<DataTableColumn<Workflow>>>(
    () => [
      displayColumn<Workflow>("name", "이름", (row) => (
        <span className="truncate">{row.name ?? row.id}</span>
      )),
      displayColumn<Workflow>("steps", "단계", (row) => (
        <span className="cell-number">{formatNumber(row.steps?.length ?? 0)}</span>
      )),
      displayColumn<Workflow>("teams", "허용 팀", (row) => row.allowed_teams || "전체"),
      displayColumn<Workflow>("enabled", "상태", (row) => (
        <Badge tone={row.enabled ? "success" : "muted"}>{row.enabled ? "사용" : "중지"}</Badge>
      )),
      displayColumn<Workflow>("updated_at", "수정일", (row) => formatDateTime(row.updated_at)),
    ],
    [],
  );
  const runColumns = useMemo<ReadonlyArray<DataTableColumn<WorkflowRun>>>(
    () => [
      displayColumn<WorkflowRun>("created_at", "실행 시각", (row) => formatDateTime(row.created_at)),
      displayColumn<WorkflowRun>(
        "workflow",
        "워크플로",
        (row) =>
          workflows.find((workflow) => workflow.id === row.workflow_id)?.name ?? row.workflow_id ?? "—",
      ),
      displayColumn<WorkflowRun>("status", "상태", (row) => {
        const state = Object.hasOwn(states, row.status ?? "")
          ? states[row.status as keyof typeof states]
          : undefined;
        return <Badge tone={state?.tone ?? "muted"}>{state?.label ?? (row.status || "—")}</Badge>;
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
    ],
    [workflows],
  );
  return { columns, runColumns };
}
