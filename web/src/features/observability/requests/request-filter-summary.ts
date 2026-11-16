import type { AppRequestsQuery } from "@/shared/api/schemas";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { filterKeys } from "./request-page-query";

export type RequestFilterKey = (typeof filterKeys)[number];
export const requestFilterLabels: Record<RequestFilterKey, string> = {
  from: "시작 시각",
  to: "종료 시각",
  status: "상태",
  model: "모델",
  provider_ref: "공급자 참조",
  request_id: "요청 ID",
  trace_id: "추적 ID",
  session_id: "세션 ID",
  api_key_id: "API 키 ID",
  ip: "클라이언트 IP",
  language: "언어",
};
export const advancedRequestFilterKeys = ["trace_id", "session_id", "api_key_id", "ip", "language"] as const;

const statusNames: Record<string, string> = {
  success: "성공 (2xx·3xx)",
  error: "오류 (4xx·5xx)",
  "4xx": "클라이언트 오류 (4xx)",
  "5xx": "서버 오류 (5xx)",
};

export function requestFilterSummary(query: AppRequestsQuery, credentialPrefixes: readonly string[]) {
  return filterKeys.flatMap((key) => {
    const value = query[key];
    if (!value) return [];
    const display = containsPotentialSecret(value, credentialPrefixes)
      ? "[값 비공개]"
      : key === "status"
        ? (statusNames[value] ?? `HTTP ${value}`)
        : value;
    return [{ key, label: requestFilterLabels[key], value: display }];
  });
}

export function withoutRequestFilter(search: URLSearchParams, key: RequestFilterKey): URLSearchParams {
  const next = new URLSearchParams(search);
  next.delete(key);
  next.delete("cursor");
  return next;
}
