import type { AppRequestSummary } from "@/shared/api/schemas";
import type { CsvColumn } from "@/shared/utils/csv";

/** The rows this page already shows, through the same safe projection; never prompt content. */
export const requestCsvColumns: ReadonlyArray<CsvColumn<AppRequestSummary>> = [
  { header: "시각", value: (row) => row.created_at },
  { header: "상태", value: (row) => row.status_code },
  { header: "요청 ID", value: (row) => row.request_id },
  { header: "추적 ID", value: (row) => row.trace_id },
  { header: "세션 ID", value: (row) => row.session_id },
  { header: "API 키 ID", value: (row) => row.api_key_id },
  { header: "클라이언트 IP", value: (row) => row.ip },
  { header: "모델", value: (row) => row.model },
  { header: "공급자", value: (row) => row.provider_display },
  { header: "경로", value: (row) => row.endpoint },
  { header: "스트리밍", value: (row) => (row.stream ? "사용" : "미사용") },
  { header: "지연(ms)", value: (row) => row.latency_ms },
  { header: "첫 청크(ms)", value: (row) => row.first_chunk_ms },
  { header: "입력 토큰", value: (row) => row.prompt_tokens },
  { header: "출력 토큰", value: (row) => row.completion_tokens },
  { header: "전체 토큰", value: (row) => row.total_tokens },
  { header: "추정 비용", value: (row) => row.estimated_cost },
  { header: "통화", value: (row) => row.currency },
  { header: "종료 사유", value: (row) => row.finish_reason },
];

export function requestCsvFilename(generatedAt: string, selected = false): string {
  return `requests-${selected ? "selected-" : ""}${generatedAt.replace(/[^0-9]/gu, "").slice(0, 14)}.csv`;
}
