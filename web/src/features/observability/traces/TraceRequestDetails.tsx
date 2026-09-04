import { Search, X } from "lucide-react";
import type { RefObject } from "react";
import { Link } from "react-router";

import { formatTraceDate, formatTraceDuration } from "@/features/observability/traces/trace-utils";
import type { AppRequestSummary } from "@/shared/api/schemas";
import { Button } from "@/shared/components/ui/Button";

interface TraceRequestDetailsProps {
  detailRef: RefObject<HTMLElement | null>;
  onClear: () => void;
  request?: AppRequestSummary;
  requestExplorerHref: string;
  selectionActive: boolean;
  selectionOrdinal?: number;
  selectionUnavailable: boolean;
  timeZone: string;
}

export function TraceRequestDetails({
  detailRef,
  onClear,
  request,
  requestExplorerHref,
  selectionActive,
  selectionOrdinal,
  selectionUnavailable,
  timeZone,
}: TraceRequestDetailsProps): React.JSX.Element | null {
  if (!selectionActive) return null;

  if (!request) {
    return (
      <section
        ref={detailRef}
        className="trace-selection-missing"
        id="trace-request-detail"
        role="status"
        tabIndex={-1}
      >
        <div>
          <strong>
            {selectionUnavailable
              ? "서버 업그레이드 중에는 요청 상세를 열 수 없습니다."
              : "선택한 요청이 현재 페이지에 없습니다."}
          </strong>
          <p>
            {selectionUnavailable
              ? "모든 서버가 v0.83.0 이상이 되면 현재 목록에서 요청 상세를 다시 선택할 수 있습니다."
              : "필터나 페이지 위치가 변경되었을 수 있습니다. 선택을 해제한 뒤 다시 찾아보세요."}
          </p>
        </div>
        <Button size="small" variant="secondary" onClick={onClear}>
          선택 해제
        </Button>
      </section>
    );
  }

  return (
    <section
      ref={detailRef}
      className="trace-detail"
      id="trace-request-detail"
      role="region"
      aria-label={
        selectionOrdinal ? `${selectionOrdinal}번째 요청 ${request.request_id}` : `요청 ${request.request_id}`
      }
      tabIndex={-1}
    >
      <header className="trace-panel-header">
        <div>
          <p className="eyebrow">선택한 요청</p>
          <h2>요청 {request.request_id}</h2>
          <p>프롬프트, 응답 본문, 원시 오류와 사용자 에이전트는 표시하지 않습니다.</p>
        </div>
        <Button size="icon" variant="ghost" aria-label="요청 상세 닫기" onClick={onClear}>
          <X aria-hidden="true" />
        </Button>
      </header>

      <dl className="trace-detail-grid">
        <div>
          <dt>요청 시각</dt>
          <dd>
            <time dateTime={request.created_at}>
              {formatTraceDate(request.created_at, timeZone, {
                dateStyle: "medium",
                timeStyle: "medium",
              })}
            </time>
          </dd>
        </div>
        <div>
          <dt>상태</dt>
          <dd>HTTP {request.status_code}</dd>
        </div>
        <div>
          <dt>모델</dt>
          <dd>{request.model || "확인 불가"}</dd>
        </div>
        <div>
          <dt>공급자</dt>
          <dd>{request.provider_display}</dd>
        </div>
        <div>
          <dt>경로</dt>
          <dd>
            <code>
              {request.method || "-"} {request.endpoint}
            </code>
          </dd>
        </div>
        <div>
          <dt>응답 방식</dt>
          <dd>{request.stream ? "스트리밍" : "일반 응답"}</dd>
        </div>
        <div>
          <dt>전체 지연</dt>
          <dd>{formatTraceDuration(request.latency_ms)}</dd>
        </div>
        <div>
          <dt>첫 청크 지연</dt>
          <dd>{formatTraceDuration(request.first_chunk_ms)}</dd>
        </div>
        <div>
          <dt>토큰</dt>
          <dd>
            입력 {request.prompt_tokens.toLocaleString("ko-KR")} · 출력{" "}
            {request.completion_tokens.toLocaleString("ko-KR")} · 전체{" "}
            {request.total_tokens.toLocaleString("ko-KR")}
          </dd>
        </div>
        <div>
          <dt>캐시·추론 토큰</dt>
          <dd>
            캐시 {request.cached_tokens.toLocaleString("ko-KR")} · 추론{" "}
            {request.reasoning_tokens.toLocaleString("ko-KR")}
          </dd>
        </div>
        <div>
          <dt>추정 비용</dt>
          <dd>
            {request.estimated_cost.toLocaleString("ko-KR")} {request.currency}
          </dd>
        </div>
        <div>
          <dt>종료 사유</dt>
          <dd>{request.finish_reason || "없음"}</dd>
        </div>
        <div>
          <dt>추적 ID</dt>
          <dd>
            <code>{request.trace_id || "없음"}</code>
          </dd>
        </div>
        <div>
          <dt>세션 ID</dt>
          <dd>
            <code>{request.session_id || "없음"}</code>
          </dd>
        </div>
      </dl>

      <div className="trace-detail-actions">
        <Link className="button button-secondary button-default" to={requestExplorerHref}>
          <Search aria-hidden="true" /> 요청 탐색기에서 열기
        </Link>
      </div>
    </section>
  );
}
