import type { CSSProperties } from "react";
import type { RequestTraceSpan } from "@/shared/api/domains/observability.schemas";
import { Badge } from "@/shared/components/ui/Badge";
import {
  flowCount,
  flowInteger,
  flowKind,
  flowMilliseconds,
  flowStatus,
  flowText,
} from "./request-flow-display";
type LaneStyle = CSSProperties & { "--span-offset": string; "--span-width": string };
export function RequestSpanRecord({
  span,
  totalMs,
  credentialPrefixes,
  showBar = true,
}: {
  span: RequestTraceSpan;
  totalMs: number;
  credentialPrefixes: readonly string[];
  showBar?: boolean;
}): React.JSX.Element {
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
    <>
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
      {showBar && positionKnown ? (
        <span className="obs-span-track" style={style} aria-hidden="true">
          <span className="obs-span-bar" />
        </span>
      ) : null}
      <span className="obs-span-facts">
        <span>기록된 상대 위치 {start === undefined ? "미확인" : `+${flowMilliseconds(start)}`}</span>
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
    </>
  );
}
