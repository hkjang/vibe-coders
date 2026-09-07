import { useQuery } from "@tanstack/react-query";
import type { RefObject } from "react";

import { withPathParams } from "@/features/agents/endpoint-path";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime, formatDuration, formatKRW, formatNumber } from "@/shared/utils/format";

interface WorkflowReceiptDialogProps {
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  runId: string;
}

/** Safe receipt for one workflow run: step status and sizes, never raw prompts or output. */
export function WorkflowReceiptDialog({
  onOpenChange,
  returnFocusRef,
  runId,
}: WorkflowReceiptDialogProps): React.JSX.Element {
  const receipt = useQuery({
    queryKey: ["agents", "workflows", "receipt", runId],
    enabled: runId !== "",
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(endpoints.domains.agents.workflows.runReceipt, { run_id: runId }), {
        signal,
        routeId: "agents.workflows",
      }),
  });

  return (
    <Dialog
      description="워크플로 실행 영수증입니다. 단계별 상태와 출력 길이만 표시하며 원문은 포함되지 않습니다."
      onOpenChange={onOpenChange}
      open={runId !== ""}
      returnFocusRef={returnFocusRef}
      title="워크플로 실행 영수증"
    >
      {receipt.isPending ? (
        <p role="status">영수증을 불러오는 중입니다.</p>
      ) : receipt.isError ? (
        <InlineNotice
          tone="danger"
          title="영수증을 불러오지 못했습니다."
          actions={
            <Button size="small" onClick={() => void receipt.refetch()}>
              다시 시도
            </Button>
          }
        >
          {safeAppErrorMessage(receipt.error, "영수증을 불러오지 못했습니다.")}
        </InlineNotice>
      ) : (
        <>
          <KeyValueList
            items={[
              { label: "실행 ID", value: receipt.data?.run_id, mono: true },
              { label: "워크플로", value: receipt.data?.workflow_name || receipt.data?.workflow_id },
              { label: "상태", value: receipt.data?.status },
              {
                label: "단계 성공",
                value: `${formatNumber(receipt.data?.steps_ok ?? 0)} / ${formatNumber(receipt.data?.steps_total ?? 0)}`,
              },
              { label: "소요", value: formatDuration(receipt.data?.latency_ms ?? 0) },
              { label: "비용", value: formatKRW(receipt.data?.cost_krw ?? 0) },
              { label: "오류 분류", value: receipt.data?.error_class },
              { label: "실행 시각", value: formatDateTime(receipt.data?.created_at) },
            ]}
          />
          {(receipt.data?.steps ?? []).length === 0 ? (
            <EmptyState
              title="단계 기록이 없습니다."
              description="계획만 세운 실행에는 단계 기록이 없습니다."
            />
          ) : (
            <div className="data-table-scroll" tabIndex={0} aria-label="실행 단계 표 영역">
              <table className="data-table">
                <caption className="sr-only">워크플로 실행 단계별 결과</caption>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">이름</th>
                    <th scope="col">종류</th>
                    <th scope="col">상태</th>
                    <th scope="col">출력 길이</th>
                  </tr>
                </thead>
                <tbody>
                  {(receipt.data?.steps ?? []).map((step) => (
                    <tr key={`${String(step.step_index ?? "")}-${step.name ?? ""}`}>
                      <td className="cell-number">{formatNumber((step.step_index ?? 0) + 1)}</td>
                      <td>{step.name || "—"}</td>
                      <td>{step.type || "—"}</td>
                      <td>{step.status || "—"}</td>
                      <td className="cell-number">{formatNumber(step.output_chars ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
