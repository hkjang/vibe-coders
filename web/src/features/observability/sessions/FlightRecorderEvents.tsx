import type { FlightRecorderEvent } from "@/shared/api/domains/observability.schemas";
import { Badge } from "@/shared/components/ui/Badge";
import { formatDateTime, formatDuration, formatKRW, formatNumber } from "@/shared/utils/format";
import { flightRecorderCodeRisk, flightRecorderKind } from "./flight-recorder-state";
import { flightEventHasRisk, type FlightEventEntry } from "./flight-event-filters";

function eventTone(event: FlightRecorderEvent): "danger" | "info" | "success" | "warning" {
  if (event.is_error) return "danger";
  if (flightEventHasRisk(event)) return "warning";
  return "success";
}

export function FlightRecorderEvents({
  entries,
  startedAt,
}: {
  entries: readonly FlightEventEntry[];
  startedAt: number;
}): React.JSX.Element {
  return (
    <ol className="obs-timeline" aria-label="표시 중인 세션 기록">
      {entries.map(({ event, ordinal }) => {
        const at = event.created_at ? new Date(event.created_at).getTime() : Number.NaN;
        const offset = Number.isFinite(at) && Number.isFinite(startedAt) ? at - startedAt : Number.NaN;
        const codeRisk = flightRecorderCodeRisk(event.code_risk);
        return (
          <li key={ordinal} className="obs-timeline-item">
            <div className="obs-timeline-when">
              <div>{formatDateTime(event.created_at)}</div>
              {Number.isFinite(offset) ? (
                <div>
                  첫 기록 대비 {offset >= 0 ? "+" : ""}
                  {formatDuration(offset)}
                </div>
              ) : null}
            </div>
            <div className="obs-timeline-body">
              <div className="obs-timeline-badges">
                <Badge tone={eventTone(event)}>{flightRecorderKind(event.kind)}</Badge>
                <Badge tone={event.is_error ? "danger" : "muted"}>
                  HTTP {formatNumber(event.status_code)}
                  {event.is_error ? " · 오류 기록" : ""}
                </Badge>
                {event.model ? <Badge tone="info">{event.model}</Badge> : null}
                {event.secret_events > 0 ? (
                  <Badge tone="warning">시크릿 {formatNumber(event.secret_events)}</Badge>
                ) : null}
                {event.policy_blocks > 0 ? (
                  <Badge tone="danger">정책 차단 {formatNumber(event.policy_blocks)}</Badge>
                ) : null}
                {event.code_risk ? <Badge tone={codeRisk.tone}>코드 위험 {codeRisk.label}</Badge> : null}
              </div>
              <div className="mono truncate" title={event.request_id}>
                {event.request_id}
              </div>
              <div className="obs-meta">
                <span>{event.endpoint}</span>
                <span>기록된 지연 {formatDuration(event.latency_ms)}</span>
                <span>토큰 {formatNumber(event.total_tokens)}</span>
                <span>비용 {formatKRW(event.cost_krw)}</span>
                <span>도구 {formatNumber(event.tool_count)}</span>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
