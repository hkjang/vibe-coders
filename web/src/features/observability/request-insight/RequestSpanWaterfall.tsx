import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import type { CSSProperties } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import {
  flowCount,
  flowInteger,
  flowKind,
  flowMilliseconds,
  flowScale,
  flowSessionHref,
  flowStatus,
  flowText,
} from "./request-flow-display";
import "@/features/observability/observability.css";
import "./request-flow.css";

const routeId = "observability.requests";

type LaneStyle = CSSProperties & { "--span-offset": string; "--span-width": string };

function FlowError({ error, prefixes }: { error: unknown; prefixes: readonly string[] }): React.JSX.Element {
  const requestId = isAppError(error) ? error.requestId : undefined;
  return (
    <>
      <p>{safeAppErrorMessage(error, "조회에 실패했습니다. 다시 시도해 주세요.")}</p>
      {requestId ? <p>요청 ID: {flowText(requestId, prefixes)}</p> : null}
    </>
  );
}

interface RequestSpanWaterfallProps {
  requestId: string;
}

/**
 * Existing per-request records, not a distributed trace or measured start/end tree.
 * Error metadata can contain originals for privileged callers. The local display
 * protection does not replace the server's role/team policy or sanitize its payload.
 */
export function RequestSpanWaterfall({ requestId }: RequestSpanWaterfallProps): React.JSX.Element {
  const { credentialPrefixes } = useAuth();
  const trace = useQuery({
    enabled: requestId !== "",
    queryKey: ["observability", "requests", requestId, "trace"],
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(endpoints.domains.observability.requests.trace, { id: requestId }), {
        routeId,
        signal,
      }),
  });
  const links = useQuery({
    enabled: requestId !== "",
    queryKey: ["observability", "requests", requestId, "links"],
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(endpoints.domains.observability.requests.links, { id: requestId }), {
        routeId,
        signal,
      }),
  });

  const spans = trace.data?.spans ?? [];
  const totalMs = flowScale(spans, trace.data?.total_ms);
  const counts = links.data?.counts ?? {};
  const sessionId = links.data?.session_id ?? "";
  const sessionHref = flowSessionHref(sessionId, credentialPrefixes);

  return (
    <SectionCard
      headingLevel={3}
      className="request-flow-card"
      title="처리 흐름"
      description="요청에 연결된 처리 기록을 보여줍니다. 이름과 오류 설명에는 열람 권한에 따라 원문이나 민감한 정보가 포함될 수 있습니다."
      actions={
        <div className="request-flow-actions">
          <Button
            size="small"
            disabled={!requestId || trace.isFetching}
            onClick={() => {
              if (requestId && !trace.isFetching) void trace.refetch();
            }}
          >
            처리 흐름 다시 조회
          </Button>
          <Button
            size="small"
            disabled={!requestId || links.isFetching}
            onClick={() => {
              if (requestId && !links.isFetching) void links.refetch();
            }}
          >
            연결 기록 다시 조회
          </Button>
          {sessionHref ? (
            <Link className="button button-secondary button-small" to={sessionHref}>
              세션 흐름 보기
            </Link>
          ) : null}
        </div>
      }
    >
      {trace.isError ? (
        <InlineNotice tone="warning" title="처리 흐름을 불러오지 못했습니다.">
          <FlowError error={trace.error} prefixes={credentialPrefixes} />
        </InlineNotice>
      ) : null}

      {trace.data && (trace.isError || trace.isFetching) ? (
        <InlineNotice tone="info" title="이전 처리 흐름을 표시합니다.">
          최신 조회가 끝나지 않았거나 실패했습니다. 아래 기록은 마지막으로 받은 응답입니다.
        </InlineNotice>
      ) : null}
      {links.isPending ? <p role="status">연결 기록을 불러오는 중입니다.</p> : null}
      {links.isError ? (
        <InlineNotice tone="warning" title="연결 기록을 불러오지 못했습니다.">
          <FlowError error={links.error} prefixes={credentialPrefixes} />
          <p>연결 건수와 세션 정보는 처리 흐름과 별도로 조회합니다.</p>
        </InlineNotice>
      ) : null}
      {links.data && (links.isError || links.isFetching) ? (
        <InlineNotice tone="info" title="이전 연결 기록을 표시합니다.">
          최신 연결 정보를 확인하지 못했습니다. 마지막 응답의 건수와 세션 정보입니다.
        </InlineNotice>
      ) : null}
      {links.data ? (
        <div className="obs-timeline-badges">
          <Badge tone="muted">도구 {flowCount(counts.tools, "건")}</Badge>
          <Badge tone="muted">MCP {flowCount(counts.mcp_tools, "건")}</Badge>
          <Badge tone="muted">Text2SQL {flowCount(counts.text2sql_spans, "단계")}</Badge>
          <Badge tone={(flowInteger(counts.tool_errors) ?? 0) > 0 ? "danger" : "muted"}>
            도구 오류 {flowCount(counts.tool_errors, "건")}
          </Badge>
        </div>
      ) : null}

      {sessionId && !sessionHref ? (
        <p className="request-flow-note">
          세션 식별자를 안전하게 확인할 수 없어 이동 링크를 표시하지 않습니다.
        </p>
      ) : null}
      {trace.isPending ? (
        <div role="status" aria-live="polite">
          처리 흐름을 불러오는 중입니다.
        </div>
      ) : trace.data && !trace.isError && spans.length === 0 ? (
        <EmptyState
          title="표시할 스팬이 없습니다."
          description="현재 응답에서 표시할 처리 기록을 확인하지 못했습니다. 처리 단계의 존재 여부나 기록의 완전성을 판단할 수 없습니다."
        />
      ) : spans.length ? (
        <>
          <p className="request-flow-note">
            상대 위치는 서버 기록 기준이며 실제 시작 시각이나 동시 실행을 뜻하지 않습니다. 막대는 기록값의
            참고 표시로, 전체 업무 시간이나 실행 순서를 보장하지 않습니다. 기록된 지연 0도 실측 0을 보장하지
            않으며 도구별 소요 시간은 기록되지 않습니다.
          </p>
          <ol className="obs-span-lanes" aria-label="요청 스팬 흐름">
            {spans.map((span) => {
              const start = flowInteger(span.start_offset_ms);
              const duration = flowInteger(span.duration_ms);
              const positionKnown =
                start !== undefined && duration !== undefined && flowInteger(start + duration) !== undefined;
              const status = flowStatus(span);
              const style: LaneStyle = {
                "--span-offset": `${Math.min(100, ((start ?? 0) / totalMs) * 100)}%`,
                "--span-width": `${Math.max(0.5, Math.min(100, ((duration ?? 0) / totalMs) * 100))}%`,
              };
              return (
                <li key={span.span_id} className="obs-span-lane">
                  <span className="obs-span-heading">
                    <span>
                      <code>{flowText(span.name || span.span_id, credentialPrefixes)}</code>
                      <small>{flowKind(span.kind, credentialPrefixes)}</small>
                    </span>
                    <span className="request-flow-status">
                      <Badge tone={status.tone}>{status.label}</Badge>
                      {span.cache_hit ? <Badge tone="info">캐시 적중</Badge> : null}
                    </span>
                  </span>
                  {positionKnown ? (
                    <span className="obs-span-track" style={style} aria-hidden="true">
                      <span className="obs-span-bar" />
                    </span>
                  ) : null}
                  <span className="obs-span-facts">
                    <span>
                      기록된 상대 위치 {start === undefined ? "미확인" : `+${flowMilliseconds(start)}`}
                    </span>
                    <span>
                      {span.kind === "tool" || span.kind === "mcp_tool"
                        ? "소요 시간 미기록"
                        : `기록된 지연 ${flowMilliseconds(duration)}`}
                    </span>
                    {span.tokens !== undefined && span.tokens !== null ? (
                      <span>토큰 {flowCount(span.tokens, "개")}</span>
                    ) : null}
                    {status.label === "상태 미확인" ? (
                      <span>기록 상태: {flowText(span.status, credentialPrefixes, "미확인")}</span>
                    ) : null}
                    {span.error ? (
                      <span className="obs-span-error">{flowText(span.error, credentialPrefixes)}</span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      ) : null}
    </SectionCard>
  );
}
