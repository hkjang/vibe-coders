import { useId, type CSSProperties } from "react";

import {
  buildTraceTimeline,
  formatTraceDate,
  formatTraceDuration,
  traceStatusTone,
} from "@/features/observability/traces/trace-utils";
import type { AppRequestSummary } from "@/shared/api/schemas";
import { Badge } from "@/shared/components/ui/Badge";

interface TraceTimelineProps {
  onSelect: (request: AppRequestSummary, trigger: HTMLButtonElement) => void;
  requests: readonly AppRequestSummary[];
  selectionEnabled: boolean;
  selectionDisabledReason?: string;
  selectedRequestRef?: string;
  timeZone: string;
}

type TimelineStyle = CSSProperties & {
  "--trace-offset": string;
  "--trace-width": string;
};

export function TraceTimeline({
  onSelect,
  requests,
  selectionEnabled,
  selectionDisabledReason,
  selectedRequestRef,
  timeZone,
}: TraceTimelineProps): React.JSX.Element {
  const timeline = buildTraceTimeline(requests);
  const reasonId = useId();

  return (
    <section className="trace-panel" aria-labelledby="trace-timeline-title">
      <header className="trace-panel-header">
        <div>
          <h2 id="trace-timeline-title">요청 처리 흐름</h2>
          <p>
            각 막대는 안전한 운영 메타데이터의 요청 기록 시각과 기록된 지연을 나타냅니다. 실제 실행 시작·종료
            시각을 보장하지 않습니다.
          </p>
        </div>
        <Badge tone="info">요청 단위</Badge>
      </header>
      {selectionDisabledReason ? <p id={reasonId}>{selectionDisabledReason}</p> : null}

      <div className="trace-scale" aria-hidden="true">
        <span>0ms</span>
        <span>{formatTraceDuration(timeline.spanMs / 2)}</span>
        <span>{formatTraceDuration(timeline.spanMs)}</span>
      </div>
      <ol className="trace-lanes">
        {timeline.lanes.map(({ offsetPercent, request, startOffsetMs, widthPercent }, index) => {
          const selected = request.request_ref === selectedRequestRef;
          const style: TimelineStyle = {
            "--trace-offset": `${offsetPercent}%`,
            "--trace-width": `${widthPercent}%`,
          };
          return (
            <li key={request.request_ref}>
              <button
                type="button"
                className="trace-lane"
                aria-controls={selected ? "trace-request-detail" : undefined}
                aria-expanded={selected}
                aria-label={`${index + 1}번째 요청 ${request.request_id} 흐름 선택`}
                aria-pressed={selected}
                disabled={!selectionEnabled}
                aria-disabled={selectionDisabledReason ? true : undefined}
                aria-describedby={selectionDisabledReason ? reasonId : undefined}
                title={
                  selectionEnabled ? selectionDisabledReason : "서버 배포 완료 후 요청 상세를 열 수 있습니다."
                }
                onClick={(event) => {
                  if (selectionEnabled && !selectionDisabledReason) onSelect(request, event.currentTarget);
                }}
              >
                <span className="trace-lane-heading">
                  <span>
                    <code title={request.request_id}>{request.request_id}</code>
                    <small>{request.model || "모델 미확인"}</small>
                  </span>
                  <Badge tone={traceStatusTone(request.status_code)}>HTTP {request.status_code}</Badge>
                </span>
                <span className="trace-lane-track" style={style} aria-hidden="true">
                  <span className="trace-lane-bar" />
                </span>
                <span className="trace-lane-facts">
                  <span>
                    기록 +{formatTraceDuration(startOffsetMs)} · 기록된 지연{" "}
                    {formatTraceDuration(request.latency_ms)}
                  </span>
                  <time dateTime={request.created_at}>
                    {formatTraceDate(request.created_at, timeZone, {
                      dateStyle: "short",
                      timeStyle: "medium",
                    })}
                  </time>
                </span>
                <span className="trace-lane-context">
                  <span>{request.provider_display}</span>
                  <code title={request.trace_id || undefined}>
                    {request.trace_id ? `추적 ${request.trace_id}` : "추적 ID 없음"}
                  </code>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
