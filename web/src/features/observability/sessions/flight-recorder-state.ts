import type { FlightRecorderEvent } from "@/shared/api/domains/observability.schemas";
import type { NoticeTone } from "@/shared/components/ui/InlineNotice";
import { toCsv } from "@/shared/utils/csv";

export const flightRecorderDescription = "목록 기간과 별개인 세션의 제한된 최근 요청을 보여줍니다.";

export function flightRecorderVerdict(verdict: string): { title: string; tone: NoticeTone } {
  if (verdict === "위험") return { title: "판정: 위험", tone: "danger" };
  if (verdict === "주의") return { title: "판정: 주의", tone: "warning" };
  if (verdict === "정상") return { title: "판정: 정상", tone: "success" };
  return { title: "판정 확인 불가", tone: "info" };
}

export function flightRecorderKind(kind: string): string {
  switch (kind) {
    case "chat":
      return "대화";
    case "embedding":
      return "임베딩";
    case "responses":
      return "응답 생성";
    case "messages":
      return "메시지";
    case "completion":
      return "텍스트 완성";
    default:
      return "기타 요청";
  }
}

export function flightRecorderCodeRisk(risk: string): { label: string; tone: "warning" | "info" } {
  switch (risk) {
    case "high":
      return { label: "높음", tone: "warning" };
    case "medium":
      return { label: "보통", tone: "warning" };
    case "low":
      return { label: "낮음", tone: "warning" };
    default:
      return { label: "확인 불가", tone: "info" };
  }
}

/** Existing fifteen columns and shared escaping; no new raw fields or filename policy. */
export function flightRecorderCsv(events: readonly FlightRecorderEvent[]): string {
  return toCsv(events, [
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
  ]);
}
