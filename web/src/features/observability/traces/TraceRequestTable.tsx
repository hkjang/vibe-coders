import {
  formatTraceDate,
  formatTraceDuration,
  orderTraceRequests,
  traceStatusTone,
} from "@/features/observability/traces/trace-utils";
import type { AppRequestSummary } from "@/shared/api/schemas";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";

interface TraceRequestTableProps {
  onSelect: (request: AppRequestSummary, trigger: HTMLButtonElement) => void;
  requests: readonly AppRequestSummary[];
  selectionEnabled: boolean;
  selectedRequestRef?: string;
  timeZone: string;
}

export function TraceRequestTable({
  onSelect,
  requests,
  selectionEnabled,
  selectedRequestRef,
  timeZone,
}: TraceRequestTableProps): React.JSX.Element {
  const orderedRequests = orderTraceRequests(requests);

  return (
    <section className="trace-request-list" aria-labelledby="trace-request-list-title">
      <header>
        <div>
          <h2 id="trace-request-list-title">요청 목록</h2>
          <p>처리 흐름에 표시된 요청의 안전한 운영 메타데이터입니다.</p>
        </div>
        <span>{orderedRequests.length.toLocaleString("ko-KR")}건</span>
      </header>
      <div className="data-table-shell">
        <div className="data-table-scroll">
          <table className="data-table trace-request-table">
            <caption className="sr-only">
              요청 시각, 상태, 식별자, 모델, 공급자, 지연, 토큰과 비용 목록
            </caption>
            <thead>
              <tr>
                <th scope="col">시각</th>
                <th scope="col">상태</th>
                <th scope="col">요청 ID</th>
                <th scope="col">모델</th>
                <th scope="col">공급자</th>
                <th scope="col" title="밀리초 또는 초 단위의 전체 처리 지연">
                  지연
                </th>
                <th scope="col" title="입력과 출력 등을 합산한 전체 토큰">
                  토큰
                </th>
                <th scope="col" title="요청 처리의 추정 비용과 통화">
                  비용
                </th>
                <th scope="col">
                  <span className="sr-only">상세 작업</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {orderedRequests.map((request, index) => {
                const selected = request.request_ref === selectedRequestRef;
                return (
                  <tr key={request.request_ref} data-selected={selected || undefined}>
                    <td>
                      <time dateTime={request.created_at}>
                        {formatTraceDate(request.created_at, timeZone, {
                          dateStyle: "short",
                          timeStyle: "medium",
                        })}
                      </time>
                    </td>
                    <td>
                      <Badge tone={traceStatusTone(request.status_code)}>HTTP {request.status_code}</Badge>
                    </td>
                    <td>
                      <code title={request.request_id}>{request.request_id}</code>
                    </td>
                    <td>{request.model || "확인 불가"}</td>
                    <td>{request.provider_display}</td>
                    <td>{formatTraceDuration(request.latency_ms)}</td>
                    <td>{request.total_tokens.toLocaleString("ko-KR")}</td>
                    <td>
                      {request.estimated_cost.toLocaleString("ko-KR")} {request.currency}
                    </td>
                    <td className="data-table-action-cell">
                      <Button
                        size="small"
                        variant={selected ? "secondary" : "ghost"}
                        aria-controls={selected ? "trace-request-detail" : undefined}
                        aria-expanded={selected}
                        aria-label={`${index + 1}번째 요청 ${request.request_id} 상세 보기`}
                        aria-pressed={selected}
                        disabled={!selectionEnabled}
                        title={selectionEnabled ? undefined : "서버 배포 완료 후 요청 상세를 열 수 있습니다."}
                        onClick={(event) => onSelect(request, event.currentTarget)}
                      >
                        {selected ? "선택됨" : "상세"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
