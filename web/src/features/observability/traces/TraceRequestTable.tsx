import {
  formatTraceDate,
  formatTraceDuration,
  traceStatusTone,
} from "@/features/observability/traces/trace-utils";
import type { AppRequestSummary } from "@/shared/api/schemas";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";

interface TraceRequestTableProps {
  onSelect: (requestId: string, trigger: HTMLButtonElement) => void;
  requests: readonly AppRequestSummary[];
  selectedRequestId?: string;
  timeZone: string;
}

export function TraceRequestTable({
  onSelect,
  requests,
  selectedRequestId,
  timeZone,
}: TraceRequestTableProps): React.JSX.Element {
  return (
    <section className="trace-request-list" aria-labelledby="trace-request-list-title">
      <header>
        <div>
          <h2 id="trace-request-list-title">요청 목록</h2>
          <p>처리 흐름에 표시된 요청의 안전한 운영 메타데이터입니다.</p>
        </div>
        <span>{requests.length.toLocaleString("ko-KR")}건</span>
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
              {requests.map((request) => {
                const selected = request.request_id === selectedRequestId;
                return (
                  <tr key={request.request_id} data-selected={selected || undefined}>
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
                        aria-label={`요청 ${request.request_id} 상세 보기`}
                        aria-pressed={selected}
                        onClick={(event) => onSelect(request.request_id, event.currentTarget)}
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
