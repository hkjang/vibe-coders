import type { AppRequestsResponse, AppRequestSummary } from "@/shared/api/schemas";
import { Button } from "@/shared/components/ui/Button";
import { TraceRequestTable } from "./TraceRequestTable";
import { TraceTimeline } from "./TraceTimeline";
import { formatTraceDate, formatTraceDuration, traceCount } from "./trace-utils";

interface TraceListResultsProps {
  data: AppRequestsResponse;
  timeZone: string;
  selectedRequestRef?: string;
  selectionDisabledReason?: string;
  ready: boolean;
  onSelect: (request: AppRequestSummary, trigger: HTMLButtonElement) => void;
  onPage: (cursor: string) => void;
}

export function TraceListResults({
  data,
  timeZone,
  selectedRequestRef,
  selectionDisabledReason,
  ready,
  onSelect,
  onPage,
}: TraceListResultsProps) {
  const requests = data.requests;
  const averageLatency = requests.length
    ? requests.reduce((total, request) => total + request.latency_ms, 0) / requests.length
    : 0;
  const failedRequests = requests.filter(
    (request) => request.status_code >= 400 && request.status_code < 600,
  ).length;
  const selectionEnabled = data.request_contract_version === 2;

  return (
    <>
      <section className="trace-summary" aria-label="추적 요청 요약">
        <article>
          <span>표시 요청</span>
          <strong>{requests.length.toLocaleString("ko-KR")}건</strong>
        </article>
        <article>
          <span>추적 ID</span>
          <strong>{traceCount(requests).toLocaleString("ko-KR")}개</strong>
        </article>
        <article>
          <span>평균 지연</span>
          <strong>{formatTraceDuration(Math.round(averageLatency))}</strong>
        </article>
        <article>
          <span>오류 요청</span>
          <strong>{failedRequests.toLocaleString("ko-KR")}건</strong>
        </article>
      </section>

      <TraceTimeline
        requests={requests}
        selectionEnabled={selectionEnabled}
        selectionDisabledReason={selectionDisabledReason}
        selectedRequestRef={selectedRequestRef}
        timeZone={timeZone}
        onSelect={onSelect}
      />

      <TraceRequestTable
        requests={requests}
        selectionEnabled={selectionEnabled}
        selectionDisabledReason={selectionDisabledReason}
        selectedRequestRef={selectedRequestRef}
        timeZone={timeZone}
        onSelect={onSelect}
      />

      <div className="trace-pagination">
        <span>
          마지막 갱신{" "}
          <time data-testid="traces-generated-at" dateTime={data.generated_at}>
            {formatTraceDate(data.generated_at, timeZone, { timeStyle: "medium" })}
          </time>
        </span>
        <div>
          <Button
            variant="secondary"
            size="small"
            disabled={!data.previous_cursor || !ready}
            onClick={() => {
              if (data.previous_cursor) onPage(data.previous_cursor);
            }}
          >
            이전
          </Button>
          <Button
            variant="secondary"
            size="small"
            disabled={!data.next_cursor || !ready}
            onClick={() => {
              if (data.next_cursor) onPage(data.next_cursor);
            }}
          >
            다음
          </Button>
        </div>
      </div>
    </>
  );
}
