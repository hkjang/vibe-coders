import { useQuery } from "@tanstack/react-query";
import type { RefObject } from "react";

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
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  runId: string;
}

/** Safe receipt for one AI work-app run: metadata only, input recorded as a hash. */
export function AppReceiptDialog({
  onOpenChange,
  returnFocusRef,
  runId,
}: AppReceiptDialogProps): React.JSX.Element {
  const receipt = useQuery({
    queryKey: ["agents", "apps", "receipt", runId],
    enabled: runId !== "",
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(endpoints.domains.agents.apps.runReceipt, { run_id: runId }), {
        signal,
        routeId: "agents.apps",
      }),
  });

  return (
    <Dialog
      description="업무 앱 실행 영수증입니다. 원문 입력과 출력은 포함되지 않습니다."
      onOpenChange={onOpenChange}
      open={runId !== ""}
      returnFocusRef={returnFocusRef}
      title="업무 앱 실행 영수증"
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
        <KeyValueList
          items={[
            { label: "실행 ID", value: receipt.data?.run_id, mono: true },
            { label: "앱", value: receipt.data?.app_title || receipt.data?.app_id },
            { label: "상태", value: receipt.data?.status },
            { label: "요약", value: receipt.data?.output_summary },
            { label: "입력 해시", value: receipt.data?.input_hash, mono: true },
            { label: "소요", value: formatDuration(receipt.data?.latency_ms ?? 0) },
            { label: "비용", value: formatKRW(receipt.data?.cost_krw ?? 0) },
            { label: "오류 분류", value: receipt.data?.error_class },
            { label: "실행 시각", value: formatDateTime(receipt.data?.created_at) },
          ]}
        />
      )}
    </Dialog>
  );
}
