import type { RequestTraceSpan } from "@/shared/api/domains/observability.schemas";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { formatNumber } from "@/shared/utils/format";

export const hiddenFlowText = "민감정보가 포함될 수 있어 표시하지 않습니다.";

/** Display-only protection; does not change the response or promise PII removal. */
export function flowText(value: string | undefined, prefixes: readonly string[], empty = "—"): string {
  if (!value) return empty;
  return containsPotentialSecret(value, prefixes) ? hiddenFlowText : value;
}

/** A usable parsed integer, not proof of a strict/raw server response contract. */
export function flowInteger(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function flowCount(value: number | null | undefined, unit: string): string {
  const count = flowInteger(value);
  return count === undefined ? "미확인" : `${formatNumber(count)}${unit}`;
}

export function flowMilliseconds(value: number | null | undefined): string {
  const milliseconds = flowInteger(value);
  return milliseconds === undefined ? "미확인" : `${formatNumber(milliseconds)}ms`;
}

export function flowKind(value: string | undefined, prefixes: readonly string[]): string {
  switch (value) {
    case "request":
      return "요청";
    case "cache":
      return "캐시";
    case "tool":
      return "도구";
    case "mcp_tool":
      return "MCP 도구";
    case "text2sql":
      return "Text2SQL";
    default:
      return `종류 미확인 (${flowText(value, prefixes)})`;
  }
}

export function flowStatus(span: RequestTraceSpan): {
  label: string;
  tone: "danger" | "warning" | "success" | "muted";
} {
  // A skip reason is carried in the error field too. It is not proof that the
  // skipped stage executed and failed. Cache is separate from execution status.
  if (span.status === "error") return { label: "오류", tone: "danger" };
  if (span.status === "skipped") return { label: "건너뜀", tone: "muted" };
  if (span.status === "ok") {
    return span.error ? { label: "오류 정보 있음", tone: "warning" } : { label: "정상", tone: "success" };
  }
  return { label: "상태 미확인", tone: "warning" };
}

export function flowSessionHref(value: string | undefined, prefixes: readonly string[]): string | undefined {
  if (!value || containsPotentialSecret(value, prefixes) || /\[REDACTED[^\]]*\]/iu.test(value))
    return undefined;
  // Router basename already supplies /app. Encoding is not a privacy measure;
  // the original response ID must pass the display/credential check first.
  try {
    return `/observability/xview?session_id=${encodeURIComponent(value)}`;
  } catch {
    // A loose string contract may include an unmatched UTF-16 surrogate.
    // Keep the records visible, but do not invent a replacement identity.
    return undefined;
  }
}

export function flowScale(spans: readonly RequestTraceSpan[], total: number | null | undefined): number {
  let scale = Math.max(flowInteger(total) ?? 0, 1);
  for (const span of spans) {
    const offset = flowInteger(span.start_offset_ms);
    const duration = flowInteger(span.duration_ms);
    if (offset !== undefined && duration !== undefined) {
      const end = flowInteger(offset + duration);
      if (end !== undefined) scale = Math.max(scale, end);
    }
  }
  // Preserve the existing visual scale for valid data. It is not an actual
  // request end, critical path or corrected start/end reconstruction.
  return scale;
}
