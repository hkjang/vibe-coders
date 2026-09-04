import type { RefObject } from "react";
import { Link } from "react-router";

import type { AppRequestSummary } from "@/shared/api/schemas";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { formatRequestDate } from "@/features/observability/requests/request-date";

interface RequestDetailDialogProps {
  legacyHref?: `/admin${string}`;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  request?: AppRequestSummary;
  returnFocusRef: RefObject<HTMLElement | null>;
  timeZone: string;
}

export function RequestDetailDialog({
  legacyHref,
  onOpenChange,
  open,
  request,
  returnFocusRef,
  timeZone,
}: RequestDetailDialogProps): React.JSX.Element {
  return (
    <Dialog
      description="프롬프트, 응답 본문, 원시 오류와 사용자 에이전트는 이 미리보기에서 제공하지 않습니다."
      footer={
        <>
          {request?.trace_id ? (
            <Link
              className="button button-secondary button-default"
              to={{
                pathname: "/observability/traces",
                search: new URLSearchParams({
                  selected_request: request.request_id,
                  trace_id: request.trace_id,
                }).toString(),
              }}
            >
              이 요청의 추적 보기
            </Link>
          ) : null}
          {legacyHref ? (
            <a className="button button-secondary button-default" href={legacyHref}>
              기존 요청 화면 열기
            </a>
          ) : null}
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            닫기
          </Button>
        </>
      }
      onOpenChange={onOpenChange}
      open={open}
      returnFocusRef={returnFocusRef}
      title={request ? `요청 ${request.request_id}` : "요청 상세"}
    >
      {request ? (
        <dl className="request-detail-grid">
          <div>
            <dt>요청 시각</dt>
            <dd>
              <time data-testid="request-detail-created-at" dateTime={request.created_at}>
                {formatRequestDate(request.created_at, timeZone, {
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
            <dt>스트리밍</dt>
            <dd>{request.stream ? "사용" : "미사용"}</dd>
          </div>
          <div>
            <dt>전체 지연</dt>
            <dd>{request.latency_ms.toLocaleString("ko-KR")}ms</dd>
          </div>
          <div>
            <dt>첫 청크 지연</dt>
            <dd>{request.first_chunk_ms.toLocaleString("ko-KR")}ms</dd>
          </div>
          <div>
            <dt>전체 토큰</dt>
            <dd>{request.total_tokens.toLocaleString("ko-KR")}</dd>
          </div>
          <div>
            <dt>추정 비용</dt>
            <dd>
              {request.estimated_cost.toLocaleString("ko-KR")} {request.currency}
            </dd>
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
          <div>
            <dt>API 키 ID</dt>
            <dd>
              <code>{request.api_key_id || "없음"}</code>
            </dd>
          </div>
          <div>
            <dt>클라이언트 IP</dt>
            <dd>
              <code>{request.ip}</code>
            </dd>
          </div>
          <div>
            <dt>공급자 참조</dt>
            <dd>
              <code>{request.provider_ref}</code>
            </dd>
          </div>
          <div>
            <dt>종료 사유</dt>
            <dd>{request.finish_reason || "없음"}</dd>
          </div>
        </dl>
      ) : null}
    </Dialog>
  );
}
