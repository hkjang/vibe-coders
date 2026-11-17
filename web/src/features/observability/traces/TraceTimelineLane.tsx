import type { CSSProperties } from "react";
import type { AppRequestSummary } from "@/shared/api/schemas";
import { Badge } from "@/shared/components/ui/Badge";
import {
  formatTraceDate,
  formatTraceDuration,
  traceStatusTone,
  type TraceTimelineLane as Lane,
} from "./trace-utils";
export interface TraceLaneControls {
  onSelect: (request: AppRequestSummary, trigger: HTMLButtonElement) => void;
  selectionEnabled: boolean;
  selectionDisabledReason?: string;
  selectedRequestRef?: string;
  timeZone: string;
  reasonId: string;
}
export function TraceTimelineLane({
  lane,
  ordinal,
  ...controls
}: TraceLaneControls & { lane: Lane; ordinal: number }) {
  const { request, offsetPercent, widthPercent, startOffsetMs } = lane;
  const { onSelect, selectionEnabled, selectionDisabledReason, selectedRequestRef, timeZone, reasonId } =
    controls;
  const selected = request.request_ref === selectedRequestRef;
  const style = {
    "--trace-offset": `${offsetPercent}%`,
    "--trace-width": `${widthPercent}%`,
  } as CSSProperties;
  return (
    <li>
      <button
        type="button"
        className="trace-lane"
        aria-controls={selected ? "trace-request-detail" : undefined}
        aria-expanded={selected}
        aria-label={`${ordinal}번째 요청 ${request.request_id} 흐름 선택`}
        aria-pressed={selected}
        disabled={!selectionEnabled}
        aria-disabled={selectionDisabledReason ? true : undefined}
        aria-describedby={selectionDisabledReason ? reasonId : undefined}
        title={selectionEnabled ? selectionDisabledReason : "서버 배포 완료 후 요청 상세를 열 수 있습니다."}
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
            기록 +{formatTraceDuration(startOffsetMs)} · 기록된 지연 {formatTraceDuration(request.latency_ms)}
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
}
