import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";

import { apiClient } from "@/shared/api/client";
import type { FlightRecorderEvent } from "@/shared/api/domains/observability.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { downloadCsv, toCsv } from "@/shared/utils/csv";
import { formatDateTime, formatDuration, formatKRW, formatNumber } from "@/shared/utils/format";

interface FlightRecorderPanelProps {
  sessionId: string;
}

function verdictTone(verdict: string): "danger" | "success" | "warning" {
  if (verdict === "위험") return "danger";
  if (verdict === "주의") return "warning";
  return "success";
}

function eventTone(event: FlightRecorderEvent): "danger" | "info" | "success" | "warning" {
  if (event.is_error) return "danger";
  if (event.secret_events > 0 || event.policy_blocks > 0 || event.code_risk === "high") return "warning";
  return "success";
}

/** Chronological flight recorder for one session (GET /admin/sessions/{id}/flight-recorder). */
export function FlightRecorderPanel({ sessionId }: FlightRecorderPanelProps): React.JSX.Element {
  const recorder = useQuery({
    queryKey: ["observability", "sessions", "flight-recorder", sessionId],
    queryFn: ({ signal }) =>
      apiClient.request(
        withPathParams(endpoints.domains.observability.sessions.flightRecorder, {
          session_id: sessionId,
        }),
        { signal, routeId: "observability.sessions.flight-recorder" },
      ),
    enabled: sessionId !== "",
    staleTime: 30_000,
  });

  if (recorder.isPending) {
    return (
      <div role="status" aria-live="polite">
        비행기록을 불러오는 중입니다.
      </div>
    );
  }

  if (recorder.isError || !recorder.data) {
    return (
      <InlineNotice
        tone="danger"
        title="비행기록을 불러오지 못했습니다."
        actions={
          <Button size="small" onClick={() => void recorder.refetch()}>
            다시 시도
          </Button>
        }
      >
        {safeAppErrorMessage(recorder.error, "비행기록을 불러오지 못했습니다.")}
        {isAppError(recorder.error) && recorder.error.requestId ? (
          <span className="request-id"> 요청 ID: {recorder.error.requestId}</span>
        ) : null}
      </InlineNotice>
    );
  }

  const { events, rollup, summary } = recorder.data;
  const startedAt = rollup.started_at ? new Date(rollup.started_at).getTime() : Number.NaN;

  const exportCsv = (): void => {
    downloadCsv(
      `flight-recorder-${sessionId || "session"}.csv`,
      toCsv(events, [
        { header: "created_at", value: (row) => row.created_at },
        { header: "request_id", value: (row) => row.request_id },
        { header: "trace_id", value: (row) => row.trace_id },
        { header: "kind", value: (row) => row.kind },
        { header: "endpoint", value: (row) => row.endpoint },
        { header: "model", value: (row) => row.model },
        { header: "provider", value: (row) => row.provider },
        { header: "status_code", value: (row) => row.status_code },
        { header: "latency_ms", value: (row) => row.latency_ms },
        { header: "total_tokens", value: (row) => row.total_tokens },
        { header: "cost_krw", value: (row) => row.cost_krw },
        { header: "tool_count", value: (row) => row.tool_count },
        { header: "secret_events", value: (row) => row.secret_events },
        { header: "policy_blocks", value: (row) => row.policy_blocks },
        { header: "code_risk", value: (row) => row.code_risk },
      ]),
    );
  };

  return (
    <div className="obs-section-stack">
      <InlineNotice tone={verdictTone(summary.verdict)} title={`판정: ${summary.verdict || "—"}`}>
        <div>{summary.headline}</div>
        <ul className="obs-findings">
          {summary.findings.map((finding, index) => (
            <li key={index}>{finding}</li>
          ))}
        </ul>
      </InlineNotice>

      <StatGrid label="세션 롤업">
        <StatCard label="요청" value={formatNumber(rollup.requests)} />
        <StatCard
          label="오류"
          value={formatNumber(rollup.errors)}
          tone={rollup.errors > 0 ? "danger" : "default"}
        />
        <StatCard label="토큰" value={formatNumber(rollup.total_tokens)} />
        <StatCard label="비용" value={formatKRW(rollup.total_cost)} />
        <StatCard label="도구 호출" value={formatNumber(rollup.tool_calls)} />
        <StatCard
          label="위험 신호"
          value={formatNumber(
            rollup.risk.secret_requests +
              rollup.risk.policy_block_requests +
              rollup.risk.high_risk_code_requests,
          )}
          tone={
            rollup.risk.secret_requests +
              rollup.risk.policy_block_requests +
              rollup.risk.high_risk_code_requests >
            0
              ? "warning"
              : "default"
          }
          hint={`시크릿 ${rollup.risk.secret_requests} · 차단 ${rollup.risk.policy_block_requests} · 위험 코드 ${rollup.risk.high_risk_code_requests}`}
        />
      </StatGrid>

      <KeyValueList
        items={[
          { label: "세션 ID", value: recorder.data.session_id, mono: true },
          { label: "시작", value: formatDateTime(rollup.started_at) },
          { label: "종료", value: formatDateTime(rollup.ended_at) },
          { label: "모델", value: rollup.models.join(", ") },
          { label: "Provider", value: rollup.providers.join(", ") },
          { label: "추적 ID 수", value: formatNumber(rollup.trace_ids.length) },
        ]}
      />

      <SectionCard
        headingLevel={3}
        title="비행기록 타임라인"
        description={recorder.data.note || "세션 요청을 시간순으로 재구성했습니다. 원문은 포함되지 않습니다."}
        actions={
          <Button size="small" onClick={exportCsv} disabled={events.length === 0}>
            <Download aria-hidden="true" /> CSV 내보내기
          </Button>
        }
      >
        {events.length === 0 ? (
          <EmptyState
            title="기록된 이벤트가 없습니다."
            description="이 세션으로 전달된 게이트웨이 요청이 아직 없습니다."
          />
        ) : (
          <ol className="obs-timeline">
            {events.map((event, index) => {
              const at = event.created_at ? new Date(event.created_at).getTime() : Number.NaN;
              const offset = Number.isFinite(at) && Number.isFinite(startedAt) ? at - startedAt : Number.NaN;
              return (
                <li key={`${event.request_id}-${index}`} className="obs-timeline-item">
                  <div className="obs-timeline-when">
                    <div>{formatDateTime(event.created_at)}</div>
                    {Number.isFinite(offset) ? <div>+{formatDuration(offset)}</div> : null}
                  </div>
                  <div className="obs-timeline-body">
                    <div className="obs-timeline-badges">
                      <Badge tone={eventTone(event)}>{event.kind || "요청"}</Badge>
                      <Badge tone={event.is_error ? "danger" : "muted"}>
                        HTTP {formatNumber(event.status_code)}
                      </Badge>
                      {event.model ? <Badge tone="info">{event.model}</Badge> : null}
                      {event.secret_events > 0 ? (
                        <Badge tone="warning">시크릿 {formatNumber(event.secret_events)}</Badge>
                      ) : null}
                      {event.policy_blocks > 0 ? (
                        <Badge tone="danger">정책 차단 {formatNumber(event.policy_blocks)}</Badge>
                      ) : null}
                      {event.code_risk ? <Badge tone="warning">코드 위험 {event.code_risk}</Badge> : null}
                    </div>
                    <div className="mono truncate" title={event.request_id}>
                      {event.request_id}
                    </div>
                    <div className="obs-meta">
                      <span>{event.endpoint}</span>
                      <span>지연 {formatDuration(event.latency_ms)}</span>
                      <span>토큰 {formatNumber(event.total_tokens)}</span>
                      <span>비용 {formatKRW(event.cost_krw)}</span>
                      <span>도구 {formatNumber(event.tool_count)}</span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </SectionCard>
    </div>
  );
}
