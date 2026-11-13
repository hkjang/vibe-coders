import { useAppRead } from "./app-scope";
import type { RefObject } from "react";
import { AppError, isAppError } from "@/shared/api/error";
import { receiptText, runState, appRunSummary } from "../receipts/run-receipt";
import { Badge } from "@/shared/components/ui/Badge";
import { EmptyState } from "@/shared/components/ui/EmptyState";

import { withPathParams } from "@/features/agents/endpoint-path";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime, formatDuration, formatKRW } from "@/shared/utils/format";

interface AppReceiptDialogProps {
  open: boolean;
  invalidAddress: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  runId: string;
}

/** Safe receipt for one AI work-app run: metadata only, input recorded as a hash. */
export function AppReceiptDialog({
  open,
  invalidAddress,
  onOpenChange,
  returnFocusRef,
  runId,
}: AppReceiptDialogProps): React.JSX.Element {
  const receipt = useAppRead({
    queryKey: ["agents", "apps", "execution", "receipt", runId],
    enabled: open && runId !== "" && !invalidAddress,
    queryFn: async ({ signal }) => {
      const value = await apiClient.request(
        withPathParams(endpoints.domains.agents.apps.runReceipt, { run_id: runId }),
        {
          signal,
          routeId: "agents.apps",
        },
      );
      if (value.run_id !== runId)
        throw new AppError("execution_receipt_mismatch", {
          kind: "contract",
          code: "execution_receipt_mismatch",
        });
      return value;
    },
  });

  return (
    <Dialog
      description="업무 앱 실행 영수증입니다. 원문 입력과 출력은 포함되지 않습니다."
      onOpenChange={onOpenChange}
      open={open}
      scrollBody
      scrollBodyLabel="업무 앱 영수증 내용"
      returnFocusRef={returnFocusRef}
      title="업무 앱 실행 영수증"
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
        <KeyValueList
          items={[
            { label: "실행 ID", value: receipt.data?.run_id, mono: true },
            { label: "앱", value: receipt.data?.app_title || receipt.data?.app_id },
            {
              label: "상태",
              value: (
                <Badge tone={runState(receipt.data?.status).tone}>
                  {runState(receipt.data?.status).label}
                </Badge>
              ),
            },
            { label: "요약", value: appRunSummary(receipt.data?.output_summary) },
            { label: "입력 해시", value: receipt.data?.input_hash, mono: true },
            { label: "소요", value: formatDuration(receipt.data?.latency_ms) },
            { label: "비용", value: formatKRW(receipt.data?.cost_krw) },
            { label: "오류 분류", value: receipt.data?.error_class },
            { label: "실행 시각", value: formatDateTime(receipt.data?.created_at) },
          ]}
        />
      )}
    </Dialog>
  );
}
