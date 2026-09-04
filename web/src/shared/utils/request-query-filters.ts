import { isProviderRef } from "@/shared/api/provider-ref";
import { isValidIPAddress } from "@/shared/utils/ip-address";
import { isValidRequestDateTime, isValidRequestTimeZone } from "@/shared/utils/request-time-filters";
import { fitsUTF8Bytes } from "@/shared/utils/utf8";

export const requestQueryFields = [
  "from",
  "to",
  "tz",
  "status",
  "model",
  "provider_ref",
  "request_id",
  "trace_id",
  "session_id",
  "api_key_id",
  "ip",
  "language",
  "limit",
  "cursor",
] as const;

export type RequestQueryField = (typeof requestQueryFields)[number];

const fieldLabels: Readonly<Record<RequestQueryField, string>> = {
  from: "시작 시각",
  to: "종료 시각",
  tz: "시간대",
  status: "상태",
  model: "모델",
  provider_ref: "공급자 참조",
  request_id: "요청 ID",
  trace_id: "추적 ID",
  session_id: "세션 ID",
  api_key_id: "API 키 ID",
  ip: "클라이언트 IP",
  language: "언어",
  limit: "표시 건수",
  cursor: "페이지 위치",
};

const byteLimits: Readonly<Partial<Record<RequestQueryField, number>>> = {
  from: 64,
  to: 64,
  tz: 64,
  status: 16,
  model: 256,
  provider_ref: 47,
  request_id: 512,
  trace_id: 512,
  session_id: 512,
  api_key_id: 512,
  ip: 128,
  language: 64,
  limit: 3,
  cursor: 4_096,
};

const requestStatusPattern = /^(?:success|error|4xx|5xx|[1-5][0-9]{2})$/u;

function hasUnsupportedControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

export function isOpaqueAppRequestCursor(value: string): boolean {
  const [payload = "", signature = "", ...extra] = value.split(".");
  if (extra.length > 0 || !/^[A-Za-z0-9_-]+$/u.test(payload) || !/^[A-Za-z0-9_-]{43}$/u.test(signature)) {
    return false;
  }
  try {
    const standard = payload.replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
    return /^v1:[A-Za-z0-9_-]{4,}$/u.test(globalThis.atob(padded));
  } catch {
    return false;
  }
}

export function requestQueryFieldError(field: RequestQueryField, value: string): string | undefined {
  if (value === "") return undefined;
  const label = fieldLabels[field];
  if (value.trim() !== value || hasUnsupportedControl(value)) {
    return `${label} 값에 앞뒤 공백이나 제어 문자를 사용할 수 없습니다.`;
  }
  const byteLimit = byteLimits[field];
  if (byteLimit !== undefined && !fitsUTF8Bytes(value, byteLimit)) {
    return `${label}은 UTF-8 기준 ${byteLimit.toLocaleString("ko-KR")}바이트 이하여야 합니다.`;
  }

  switch (field) {
    case "from":
    case "to":
      return isValidRequestDateTime(value)
        ? undefined
        : "날짜와 시각을 YYYY-MM-DD, 로컬 시각 또는 RFC3339 형식으로 입력하세요.";
    case "tz":
      return isValidRequestTimeZone(value) ? undefined : "올바른 IANA 시간대를 입력하세요. 예: Asia/Seoul";
    case "status":
      return requestStatusPattern.test(value) ? undefined : "올바른 요청 상태를 선택하세요.";
    case "provider_ref":
      return isProviderRef(value) ? undefined : "공급자 참조 형식이 올바르지 않습니다.";
    case "ip":
      return isValidIPAddress(value) ? undefined : "올바른 IP 주소를 입력하세요.";
    case "limit": {
      const limit = Number(value);
      return /^\d{1,3}$/u.test(value) && Number.isInteger(limit) && limit >= 1 && limit <= 200
        ? undefined
        : "표시 건수는 1~200 사이의 정수여야 합니다.";
    }
    case "cursor":
      return isOpaqueAppRequestCursor(value)
        ? undefined
        : "페이지 위치 정보가 올바르지 않습니다. 필터를 다시 조회하세요.";
    default:
      return undefined;
  }
}

export function isValidRequestQueryField(field: RequestQueryField, value: string): boolean {
  return requestQueryFieldError(field, value) === undefined;
}
