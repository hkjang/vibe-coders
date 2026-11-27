import { ExternalLink } from "lucide-react";
import type { RefObject } from "react";
import { Link } from "react-router";

import { DataQueryNotice } from "@/features/data/DataQueryNotice";
import { categoryPaint } from "@/features/insights/charts/palette";
import type { WorkRequest } from "@/shared/api/domains/insights-common";
import type { WorkSessionDetail } from "@/shared/api/domains/insights-usage";
import { Badge } from "@/shared/components/ui/Badge";
import { Sheet } from "@/shared/components/ui/Sheet";
import {
  formatDateTime,
  formatDuration,
  formatKRW,
  formatNumber,
  formatPercent,
  shortId,
} from "@/shared/utils/format";

import { useSessionDetail } from "./use-usage-queries";
import {
  actionLabel,
  classificationLabel,
  classificationTone,
  completionLabel,
  completionTone,
  methodLabel,
  requestExplorerPath,
  sessionKindLabel,
  userText,
} from "./usage-labels";
import { CategoryLabel, PlainTable, WorkTitle, type PlainColumn } from "./usage-ui";

const segmentColumns: PlainColumn<WorkSessionDetail["segments"][number]>[] = [
  {
    id: "category",
    header: "업무 구간",
    cell: (row) => (
      <CategoryLabel name={row.category.name || row.category.id} paint={categoryPaint(row.category.id)} />
    ),
  },
  { id: "requests", header: "요청", numeric: true, cell: (row) => formatNumber(row.requests) },
  { id: "cost", header: "비용", numeric: true, cell: (row) => formatKRW(row.cost_krw) },
  { id: "first", header: "시작", cell: (row) => formatDateTime(row.first_at) },
  { id: "last", header: "마지막", cell: (row) => formatDateTime(row.last_at) },
];

const requestColumns: PlainColumn<WorkRequest>[] = [
  {
    id: "time",
    header: "시각",
    cell: (row) => (
      <Link
        to={requestExplorerPath(row.request_id)}
        aria-label={`요청 ${row.request_id} 요청 탐색기에서 열기`}
      >
        {formatDateTime(row.created_at)} <ExternalLink aria-hidden="true" />
      </Link>
    ),
  },
  { id: "category", header: "업무", cell: (row) => row.category.name || row.category.id },
  { id: "action", header: "작업", cell: (row) => actionLabel(row.action_type) },
  { id: "title", header: "작업 제목", cell: (row) => <WorkTitle request={row} /> },
  {
    id: "status",
    header: "분류",
    cell: (row) => <Badge tone={classificationTone(row.status)}>{classificationLabel(row.status)}</Badge>,
  },
  { id: "confidence", header: "신뢰도", numeric: true, cell: (row) => formatPercent(row.confidence, 0) },
  { id: "method", header: "방식", cell: (row) => methodLabel(row.method) },
  { id: "model", header: "모델", cell: (row) => <span className="mono">{row.model || "—"}</span> },
  { id: "tokens", header: "토큰", numeric: true, cell: (row) => formatNumber(row.tokens) },
  { id: "cost", header: "비용", numeric: true, cell: (row) => formatKRW(row.cost_krw) },
  {
    id: "latency",
    header: "지연",
    numeric: true,
    cell: (row) => (
      <>
        {formatDuration(row.latency_ms)}
        {row.is_error ? " · 오류" : ""}
      </>
    ),
  },
];

interface SessionDetailSheetProps {
  sessionId: string;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}

/** One work session: its segments by category, its totals and up to 200 of its requests. */
export function SessionDetailSheet({
  sessionId,
  returnFocusRef,
  onClose,
}: SessionDetailSheetProps): React.JSX.Element {
  const detail = useSessionDetail(sessionId);
  const session = detail.data?.session;
  return (
    <Sheet
      open
      size="wide"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`업무 세션 ${shortId(sessionId, 20)}`}
      description="세션의 업무 구간, 지표와 요청입니다. 요청을 누르면 요청 탐색기에서 열립니다."
      returnFocusRef={returnFocusRef}
      scrollLabel="업무 세션 상세"
    >
      <div className="wi-sheet-stack" aria-busy={detail.isFetching || undefined}>
        {detail.isError ? (
          <DataQueryNotice
            error={detail.error}
            hasPreviousData={detail.data !== undefined}
            label="업무 세션"
            onRetry={detail.refetch}
          />
        ) : null}
        {detail.isPending ? <p role="status">세션을 불러오는 중입니다.</p> : null}
        {session ? (
          <>
            <dl className="kv-list" data-columns="3">
              <div className="kv-item">
                <dt>세션 ID</dt>
                <dd className="mono">{session.session_id}</dd>
              </div>
              <div className="kv-item">
                <dt>세션 구분</dt>
                <dd>{sessionKindLabel(session.session_kind)}</dd>
              </div>
              <div className="kv-item">
                <dt>완료 상태</dt>
                <dd>
                  <Badge tone={completionTone(session.completion)}>
                    {completionLabel(session.completion)}
                  </Badge>
                </dd>
              </div>
              <div className="kv-item">
                <dt>주 업무</dt>
                <dd>{session.primary.name || session.primary.id}</dd>
              </div>
              <div className="kv-item">
                <dt>조직</dt>
                <dd>{session.team || "—"}</dd>
              </div>
              <div className="kv-item">
                <dt>사용자</dt>
                <dd>{userText(session.user)}</dd>
              </div>
              <div className="kv-item">
                <dt>클라이언트</dt>
                <dd>{session.client || "—"}</dd>
              </div>
              <div className="kv-item">
                <dt>기간</dt>
                <dd>
                  {formatDateTime(session.first_at)} ~ {formatDateTime(session.last_at)}
                </dd>
              </div>
              <div className="kv-item">
                <dt>소요 시간 · 모델 응답 시간</dt>
                <dd>
                  {formatDuration(session.duration_ms)} · {formatDuration(session.model_time_ms)}
                </dd>
              </div>
              <div className="kv-item">
                <dt>요청 · MCP 호출</dt>
                <dd>
                  {formatNumber(session.requests)}건 · {formatNumber(session.mcp_calls)}회
                </dd>
              </div>
              <div className="kv-item">
                <dt>토큰 (입력 · 출력)</dt>
                <dd>
                  {formatNumber(session.tokens_in)} · {formatNumber(session.tokens_out)}
                </dd>
              </div>
              <div className="kv-item">
                <dt>비용</dt>
                <dd>{formatKRW(session.cost_krw)}</dd>
              </div>
              <div className="kv-item">
                <dt>오류 · 재시도</dt>
                <dd>
                  {formatNumber(session.errors)}건 · {formatNumber(session.retries)}회
                </dd>
              </div>
              <div className="kv-item">
                <dt>모델 (전환 {formatNumber(session.model_switches)}회)</dt>
                <dd className="mono">{session.models.join(", ") || "—"}</dd>
              </div>
              <div className="kv-item">
                <dt>정책 표시</dt>
                <dd>{session.policy_flags.join(", ") || "없음"}</dd>
              </div>
            </dl>
            <p className="wi-note">
              완료 상태는 긍정 피드백이 있을 때만 ‘완료 확인’입니다. API 호출이 성공했다는 것만으로 업무가
              끝났다고 보지 않습니다.
            </p>
            <h3 className="wi-sheet-heading">업무 구간</h3>
            {detail.data && detail.data.segments.length > 0 ? (
              <PlainTable
                caption="세션의 업무 구간"
                columns={segmentColumns}
                rows={detail.data.segments}
                rowKey={(row) => row.category.id}
              />
            ) : (
              <p className="wi-note">기록된 업무 구간이 없습니다.</p>
            )}
            <h3 className="wi-sheet-heading">요청 {formatNumber(detail.data?.requests.length ?? 0)}건</h3>
            {detail.data && detail.data.requests.length > 0 ? (
              <PlainTable
                caption="세션의 요청"
                columns={requestColumns}
                rows={detail.data.requests}
                rowKey={(row) => row.request_id}
              />
            ) : (
              <p className="wi-note">표시할 요청이 없습니다.</p>
            )}
            {(detail.data?.requests.length ?? 0) >= 200 ? (
              <p className="wi-note">요청은 최대 200건까지 표시합니다.</p>
            ) : null}
          </>
        ) : null}
      </div>
    </Sheet>
  );
}
