import type { SessionListResponse, SessionSummary } from "@/shared/api/domains/observability.schemas";

export const defaultSessionDays = 7;
export const sessionListBlockedMessage = "현재 목록을 다시 확인한 뒤 세션을 선택하세요.";
export function sessionDays(value: string | null): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 365 ? parsed : defaultSessionDays;
}
export interface SessionListResult {
  response: SessionListResponse;
  requestedDays: number;
  generation: number;
}
export function sessionResponseDays(data: SessionListResult | undefined): number | undefined {
  const days = data?.response.days;
  return typeof days === "number" &&
    Number.isSafeInteger(days) &&
    days >= 1 &&
    days <= 365 &&
    days === data?.requestedDays
    ? days
    : undefined;
}
export function filterSessionRows(
  data: SessionListResponse | undefined,
  keyword: string,
): readonly SessionSummary[] {
  const rows = data?.sessions ?? [];
  const needle = keyword.toLowerCase();
  return needle === ""
    ? rows
    : rows.filter(
        (row) =>
          row.session_id.toLowerCase().includes(needle) || row.last_message.toLowerCase().includes(needle),
      );
}
export function sessionListNotice(
  days: number,
  data: SessionListResult | undefined,
  fetching: boolean,
  error: boolean,
): string {
  if (!data)
    return fetching
      ? `최근 ${days}일 세션 목록을 조회하고 있습니다.`
      : `최근 ${days}일의 표시할 현재 응답이 없습니다.`;
  const responseDays = sessionResponseDays(data);
  if (responseDays === undefined) return "응답 기간 미확인";
  if (fetching || error)
    return `최근 ${days}일 조회 ${fetching ? "중" : "실패"} · 아래 표와 합계는 이전 ${responseDays}일 결과`;
  return `아래 표와 합계는 최근 ${responseDays}일 응답의 검색 결과입니다.`;
}
