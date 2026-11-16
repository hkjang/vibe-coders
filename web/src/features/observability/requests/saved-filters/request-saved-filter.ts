import type { SavedFilter } from "@/shared/api/domains/observability.schemas";
import type { AppRequestsQuery } from "@/shared/api/schemas";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { requestQueryFieldError, requestQueryFields } from "@/shared/utils/request-query-filters";
import { validateRequestTimeFilters } from "@/shared/utils/request-time-filters";
import { fitsUTF8Bytes } from "@/shared/utils/utf8";

const labels: Record<string, string> = {
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
};
const statuses: Record<string, string> = {
  success: "성공",
  error: "오류",
  "4xx": "클라이언트 오류 (4xx)",
  "5xx": "서버 오류 (5xx)",
};
export interface SavedRequestCriteria {
  params: string;
  entries: Array<{ label: string; value: string }>;
}
export type CriteriaReview =
  { criteria: SavedRequestCriteria; error?: never } | { error: string; criteria?: never };

export function savedFilterNameError(name: string, prefixes: readonly string[]): string | undefined {
  if (!name.trim()) return "필터 이름을 입력하세요.";
  if (name.trim().length > 80) return "필터 이름은 80자 이하여야 합니다.";
  if (/[\p{Cc}\p{Cf}]/u.test(name)) return "필터 이름에 제어 문자를 사용할 수 없습니다.";
  if (containsPotentialSecret(name, prefixes)) return secretSearchMessage;
  return undefined;
}

/** Reject incompatible legacy conditions as a whole: silently omitting one can widen the query. */
export function reviewSavedRequestCriteria(raw: string, prefixes: readonly string[]): CriteriaReview {
  if (!fitsUTF8Bytes(raw, 4096)) return { error: "저장 조건은 UTF-8 기준 4,096바이트 이하여야 합니다." };
  try {
    decodeURIComponent(raw.replace(/\+/gu, " "));
  } catch {
    return { error: "저장된 조건의 인코딩이 올바르지 않습니다." };
  }
  const search = new URLSearchParams(raw);
  for (const [key, value] of search) {
    if (
      key === "cursor" ||
      !requestQueryFields.some((field) => field === key) ||
      search.getAll(key).length !== 1
    )
      return {
        error: "현재 요청 탐색기에서 지원하지 않거나 중복된 조건입니다. 기존 화면에서 조건을 확인하세요.",
      };
    if (containsPotentialSecret(value, prefixes))
      return { error: "민감 정보가 포함될 수 있어 저장된 조건을 표시하거나 적용할 수 없습니다." };
  }
  const canonical = new URLSearchParams();
  for (const field of requestQueryFields) {
    if (field === "cursor") continue;
    const value = search.get(field);
    if (value === null || value === "") continue;
    const error = requestQueryFieldError(field, value);
    if (error) return { error };
    canonical.set(field, value);
  }
  if (!canonical.has("limit")) canonical.set("limit", "50");
  if (!canonical.has("tz")) canonical.set("tz", "Asia/Seoul");
  const timeError = validateRequestTimeFilters(Object.fromEntries(canonical));
  if (timeError) return { error: timeError.message };
  return {
    criteria: {
      params: canonical.toString(),
      entries: [...canonical].map(([key, value]) => ({
        label: labels[key] ?? key,
        value: key === "status" && Object.hasOwn(statuses, value) ? (statuses[value] ?? value) : value,
      })),
    },
  };
}

export function reviewCurrentRequestCriteria(
  query: AppRequestsQuery,
  prefixes: readonly string[],
): CriteriaReview {
  const search = new URLSearchParams();
  for (const field of requestQueryFields) {
    if (field === "cursor") continue;
    const value = query[field];
    if (value !== undefined && value !== "") search.set(field, String(value));
  }
  return reviewSavedRequestCriteria(search.toString(), prefixes);
}

/** Only display safe names and use bounded, opaque IDs in mutations. Params get a separate review. */
export function visibleRequestFilters(
  filters: readonly SavedFilter[],
  prefixes: readonly string[],
): SavedFilter[] {
  const ids = new Set<string>();
  return filters.filter((filter) => {
    if (
      filter.view !== "requests" ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(filter.id) ||
      containsPotentialSecret(filter.id, prefixes) ||
      savedFilterNameError(filter.name, prefixes) ||
      ids.has(filter.id)
    )
      return false;
    ids.add(filter.id);
    return true;
  });
}
