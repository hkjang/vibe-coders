import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { formatDateTime, formatKRW, formatNumber } from "@/shared/utils/format";
import { useFlightRecorder } from "./flight-recorder-query";
import { flightRecorderVerdict } from "./flight-recorder-state";
import { FlightRecorderTimeline } from "./FlightRecorderTimeline";
import { SessionReadDenied } from "./SessionReadDenied";
import { useSessionListAccess, type SessionListAccess } from "./session-list-access";
import "./flight-recorder.css";

interface FlightRecorderPanelProps {
  sessionId: string;
}

/** Chronological flight recorder for one session (GET /admin/sessions/{id}/flight-recorder). */
export function FlightRecorderPanel({ sessionId }: FlightRecorderPanelProps): React.JSX.Element {
  const access = useSessionListAccess();
  if (!access.readable)
    return (
      <InlineNotice tone="danger" title="비행기록 조회 권한을 확인하세요.">
        현재 비행기록 조회 권한을 확인하세요.
      </InlineNotice>
    );
  return (
    <FlightRecorderContent
      key={JSON.stringify([sessionId, access.key])}
      sessionId={sessionId}
      access={access}
    />
  );
}

function FlightRecorderContent({
  sessionId,
  access,
}: FlightRecorderPanelProps & { access: SessionListAccess }): React.JSX.Element {
  const {
    query: recorder,
    refresh,
    ready,
    canExport,
    denied,
    denialRequestId,
  } = useFlightRecorder(sessionId, access);
  const requestId = isAppError(recorder.error) ? recorder.error.requestId : undefined;
  const safeRequestId =
    requestId && !containsPotentialSecret(requestId, access.prefixes) ? requestId : undefined;
  const retryButton = (
    <Button
      size="small"
      onClick={refresh}
      aria-disabled={recorder.isFetching || sessionId === ""}
      aria-busy={recorder.isFetching}
    >
      비행기록 다시 조회
    </Button>
  );
  const error = recorder.isError ? (
    <InlineNotice
      tone="danger"
      title={
        recorder.data
          ? "비행기록을 갱신하지 못했습니다. 이전 응답을 표시합니다."
          : "비행기록을 불러오지 못했습니다."
      }
    >
      {safeAppErrorMessage(recorder.error, "비행기록을 불러오지 못했습니다.")}
      {safeRequestId ? <span className="request-id"> 요청 ID: {safeRequestId}</span> : null}
    </InlineNotice>
  ) : null;
  const actions = <div className="section-card-actions">{retryButton}</div>;
  if (denied) return <SessionReadDenied detail onRetry={refresh} requestId={denialRequestId} />;
  if (!recorder.data)
    return (
      <div className="obs-section-stack flight-recorder-panel">
        {actions}
        {error ?? (
          <div role="status" aria-live="polite">
            비행기록을 불러오는 중입니다.
          </div>
        )}
      </div>
    );

  const { events, rollup, summary } = recorder.data;
  const startedAt = rollup.started_at ? new Date(rollup.started_at).getTime() : Number.NaN;
  const verdict = flightRecorderVerdict(summary.verdict);

  return (
    <div className="obs-section-stack flight-recorder-panel">
      {actions}
      {error}
      {recorder.isFetching ? (
        <p role="status">비행기록을 다시 조회하고 있습니다. 이전 응답을 표시합니다.</p>
      ) : null}
      <InlineNotice tone={verdict.tone} title={verdict.title}>
        <p>제한된 최근 기록에 대한 서버 요약이며, 세션 전체의 안전성을 보장하지 않습니다.</p>
        <div>{summary.headline}</div>
        <ul className="obs-findings">
          {summary.findings.map((finding, index) => (
            <li key={index}>{finding}</li>
          ))}
        </ul>
      </InlineNotice>

      <StatGrid label="수신 기록 집계">
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
          { label: "첫 기록 시각", value: formatDateTime(rollup.started_at) },
          { label: "마지막 기록 시각", value: formatDateTime(rollup.ended_at) },
          { label: "모델", value: rollup.models.join(", ") },
          { label: "공급자", value: rollup.providers.join(", ") },
          { label: "추적 ID 수", value: formatNumber(rollup.trace_ids.length) },
        ]}
      />

      <FlightRecorderTimeline
        events={events}
        startedAt={startedAt}
        sessionId={sessionId}
        ready={ready}
        canExport={canExport}
      />
    </div>
  );
}
