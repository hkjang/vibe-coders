import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import type { CSSProperties } from "react";

import { apiClient } from "@/shared/api/client";
import type { RequestTraceSpan } from "@/shared/api/domains/observability.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { Badge, type BadgeProps } from "@/shared/components/ui/Badge";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { formatDuration, formatNumber } from "@/shared/utils/format";
import "@/features/observability/observability.css";

const routeId = "observability.requests";

type LaneStyle = CSSProperties & { "--span-offset": string; "--span-width": string };

const kindLabels: Record<string, string> = {
  cache: "캐시",
  mcp_tool: "MCP 도구",
  request: "요청",
  text2sql: "Text2SQL",
  tool: "도구",
};

function spanTone(span: RequestTraceSpan): BadgeProps["tone"] {
  if (span.status === "error" || span.error) return "danger";
  if (span.cache_hit) return "success";
  return "info";
}

interface RequestSpanWaterfallProps {
  requestId: string;
}

/**
 * The request's end-to-end waterfall — the root span plus one child per MCP/tool call
 * and Text2SQL stage — with the counts of the records it produced elsewhere.
 *
 * The server assembles both from already-linked metadata under the caller's team scope,
 * and neither carries a prompt, a SQL statement or tool arguments, so nothing here can
 * leak the request's content.
 */
export function RequestSpanWaterfall({ requestId }: RequestSpanWaterfallProps): React.JSX.Element {
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
  // The root span's duration is the scale; a child that overruns it still gets a bar.
  const totalMs = Math.max(
    trace.data?.total_ms ?? 0,
    ...spans.map((span) => (span.start_offset_ms ?? 0) + (span.duration_ms ?? 0)),
    1,
  );
  const counts = links.data?.counts ?? {};
  const sessionId = links.data?.session_id ?? "";

  return (
    <SectionCard
      headingLevel={3}
      title="처리 흐름"
      description="요청 하나가 업스트림·MCP 도구·Text2SQL 단계로 어떻게 나뉘었는지 시간 순서로 보여줍니다. 프롬프트나 SQL 원문은 포함하지 않습니다."
      actions={
        sessionId ? (
          <Link
            className="button button-secondary button-small"
            to={`/app/observability/xview?session_id=${encodeURIComponent(sessionId)}`}
          >
            세션 흐름 보기
          </Link>
        ) : null
      }
    >
      {trace.isError ? (
        <InlineNotice tone="warning" title="처리 흐름을 불러오지 못했습니다.">
          이 요청의 스팬을 조회할 수 없습니다. 잠시 후 다시 시도해 주세요.
        </InlineNotice>
      ) : null}

      {counts.tools || counts.mcp_tools || counts.text2sql_spans || counts.tool_errors ? (
        <div className="obs-timeline-badges">
          <Badge tone="muted">도구 {formatNumber(counts.tools ?? 0)}건</Badge>
          <Badge tone={counts.mcp_tools ? "info" : "muted"}>
            MCP {formatNumber(counts.mcp_tools ?? 0)}건
          </Badge>
          <Badge tone={counts.text2sql_spans ? "info" : "muted"}>
            Text2SQL {formatNumber(counts.text2sql_spans ?? 0)}단계
          </Badge>
          <Badge tone={counts.tool_errors ? "danger" : "muted"}>
            도구 오류 {formatNumber(counts.tool_errors ?? 0)}건
          </Badge>
        </div>
      ) : null}

      {trace.isPending ? (
        <div role="status" aria-live="polite">
          처리 흐름을 불러오는 중입니다.
        </div>
      ) : spans.length === 0 ? (
        <EmptyState
          title="표시할 스팬이 없습니다."
          description="이 요청에는 업스트림 호출 외의 단계가 기록되지 않았습니다."
        />
      ) : (
        <ol className="obs-span-lanes" aria-label="요청 스팬 흐름">
          {spans.map((span) => {
            const start = span.start_offset_ms ?? 0;
            const duration = span.duration_ms ?? 0;
            const style: LaneStyle = {
              "--span-offset": `${Math.min(100, (start / totalMs) * 100)}%`,
              "--span-width": `${Math.max(0.5, Math.min(100, (duration / totalMs) * 100))}%`,
            };
            return (
              <li key={span.span_id} className="obs-span-lane">
                <span className="obs-span-heading">
                  <span>
                    <code>{span.name || span.span_id}</code>
                    <small>{kindLabels[span.kind ?? ""] ?? span.kind ?? ""}</small>
                  </span>
                  <Badge tone={spanTone(span)}>
                    {span.cache_hit ? "캐시 적중" : span.status === "error" ? "오류" : "정상"}
                  </Badge>
                </span>
                <span className="obs-span-track" style={style} aria-hidden="true">
                  <span className="obs-span-bar" />
                </span>
                <span className="obs-span-facts">
                  <span>시작 +{formatDuration(start)}</span>
                  <span>{formatDuration(duration)}</span>
                  {span.tokens ? <span>{formatNumber(span.tokens)} 토큰</span> : null}
                  {span.error ? <span className="obs-span-error">{span.error}</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </SectionCard>
  );
}
