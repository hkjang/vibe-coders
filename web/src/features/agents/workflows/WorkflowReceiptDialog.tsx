import type { RefObject } from "react";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { useWorkflowRead } from "./use-workflow-queries";
import { AppError, isAppError } from "@/shared/api/error";
import { receiptText, runState } from "../receipts/run-receipt";
import { Badge } from "@/shared/components/ui/Badge";
import { WorkflowReceiptSteps } from "./WorkflowReceiptSteps";

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
  owner: FeatureReadOwner;
  open: boolean;
  invalidAddress: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  runId: string;
}

/** Safe receipt for one workflow run: step status and sizes, never raw prompts or output. */
export function WorkflowReceiptDialog({
  owner,
  open,
  invalidAddress,
  onOpenChange,
  returnFocusRef,
  runId,
}: WorkflowReceiptDialogProps): React.JSX.Element {
  const receipt = useWorkflowRead(
    owner,
    ["execution", "receipt", runId],
    open && runId !== "" && !invalidAddress,
    async (signal) => {
      const value = await apiClient.request(
        withPathParams(endpoints.domains.agents.workflows.runReceipt, { run_id: runId }),
        {
          signal,
          routeId: "agents.workflows",
        },
      );
      if (value.run_id !== runId)
        throw new AppError("execution_receipt_mismatch", {
          kind: "contract",
          code: "execution_receipt_mismatch",
        });
      return value;
    },
  );

  return (
    <Dialog
      description="워크플로 실행 영수증입니다. 단계별 상태와 출력 길이만 표시하며 원문은 포함되지 않습니다."
      onOpenChange={onOpenChange}
      open={open}
      scrollBody
      wide
      scrollBodyLabel="워크플로 영수증 내용"
      returnFocusRef={returnFocusRef}
      title="워크플로 실행 영수증"
    >
      {invalidAddress ? (
        <InlineNotice tone="danger" title={receiptText.invalidTitle}>
          {receiptText.invalidDescription}
        </InlineNotice>
      ) : isAppError(receipt.error) && receipt.error.status === 404 ? (
        <EmptyState title={receiptText.missingTitle} description={receiptText.missingDescription} />
      ) : receipt.isPending ? (
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
              {
                label: "상태",
                value: (
                  <Badge tone={runState(receipt.data?.status).tone}>
                    {runState(receipt.data?.status).label}
                  </Badge>
                ),
              },
              {
                label: "단계 성공",
                value: `${formatNumber(receipt.data?.steps_ok)} / ${formatNumber(receipt.data?.steps_total)}`,
              },
              { label: "소요", value: formatDuration(receipt.data?.latency_ms) },
              { label: "비용", value: formatKRW(receipt.data?.cost_krw) },
              { label: "오류 분류", value: receipt.data?.error_class },
              { label: "실행 시각", value: formatDateTime(receipt.data?.created_at) },
            ]}
          />
          {(receipt.data?.steps ?? []).length === 0 ? (
            <EmptyState
              title="단계 기록이 없습니다."
              description="실행 경로에 따라 단계별 기록이 없을 수 있습니다."
            />
          ) : (
            <WorkflowReceiptSteps key={runId} steps={receipt.data?.steps ?? []} />
          )}
        </>
      )}
    </Dialog>
  );
}
