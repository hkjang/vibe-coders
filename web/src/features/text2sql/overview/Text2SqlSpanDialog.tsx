import { useQuery } from "@tanstack/react-query";
import type { RefObject } from "react";

import { StatusBadge } from "@/features/text2sql/overview/text2sql-presentation";
import { text2sqlRouteId } from "@/features/text2sql/overview/use-text2sql-queries";
import { apiClient } from "@/shared/api/client";
import type { Text2SQLSpan } from "@/shared/api/domains/text2sql";
import { endpoints } from "@/shared/api/endpoints";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { JsonBlock } from "@/shared/components/ui/JsonBlock";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { ErrorState, LoadingState } from "@/shared/components/state/PageStates";
import { isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatKRW, formatNumber } from "@/shared/utils/format";

interface Text2SqlSpanDialogProps {
  onOpenChange: (open: boolean) => void;
  requestId: string;
  returnFocusRef: RefObject<HTMLElement | null>;
}

function totalOf(spans: readonly Text2SQLSpan[], pick: (span: Text2SQLSpan) => number): number {
  return spans.reduce((sum, span) => sum + pick(span), 0);
}

/**
 * Pipeline timeline of one Text2SQL request. Stage detail can contain SQL, so it
 * is rendered here only — never written to the URL or to storage.
 */
export function Text2SqlSpanDialog({
  onOpenChange,
  requestId,
  returnFocusRef,
}: Text2SqlSpanDialogProps): React.JSX.Element {
  const open = requestId !== "";
  const spans = useQuery({
    queryKey: ["text2sql", "spans", requestId],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.text2sql.spans, {
        query: { request_id: requestId },
        signal,
        routeId: text2sqlRouteId,
      }),
    enabled: open,
  });
  const rows = spans.data?.spans ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Text2SQL 단계 타임라인"
      description="한 요청의 생성·검증·실행 단계와 단계별 지연·비용을 확인합니다."
      returnFocusRef={returnFocusRef}
      footer={
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          닫기
        </Button>
      }
    >
      {spans.isPending ? (
        <LoadingState label="단계 정보를 불러오는 중입니다." />
      ) : spans.isError ? (
        <ErrorState
          message={safeAppErrorMessage(spans.error, "단계 정보를 불러오지 못했습니다.")}
          requestId={isAppError(spans.error) ? spans.error.requestId : undefined}
          onRetry={() => void spans.refetch()}
          showLegacy={false}
        />
      ) : (
        <div className="t2s-stack">
          <KeyValueList
            items={[
              { label: "요청 ID", value: requestId, mono: true },
              { label: "단계 수", value: formatNumber(rows.length) },
              {
                label: "단계 지연 합계",
                value: `${formatNumber(totalOf(rows, (span) => span.latency_ms))} ms`,
              },
              { label: "단계 비용 합계", value: formatKRW(totalOf(rows, (span) => span.cost_krw)) },
            ]}
          />
          {rows.length === 0 ? (
            <EmptyState
              title="저장된 단계 기록이 없습니다."
              description="새 Text2SQL 요청부터 단계별 span이 수집됩니다."
            />
          ) : (
            <ol className="t2s-span-list">
              {rows.map((span, index) => (
                <li key={span.id || `${span.stage}-${index}`}>
                  <div className="t2s-span-head">
                    <strong>
                      {index + 1}. {span.stage || "-"}
                    </strong>
                    <StatusBadge value={span.status} />
                    <span>{formatNumber(span.latency_ms)} ms</span>
                    <span>{formatKRW(span.cost_krw)}</span>
                  </div>
                  <KeyValueList
                    columns={2}
                    items={[
                      { label: "모델", value: span.model, mono: true },
                      { label: "거절 사유", value: span.reject_reason },
                      { label: "입력 해시", value: span.input_hash, mono: true },
                      { label: "출력 해시", value: span.output_hash, mono: true },
                    ]}
                  />
                  {span.detail ? (
                    <JsonBlock label={`${span.stage || "단계"} 상세`} value={span.detail} />
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </Dialog>
  );
}
