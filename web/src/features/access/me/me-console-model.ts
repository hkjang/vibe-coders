import type { z } from "zod";
import { AppError, isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { formatNumber, formatKRW, formatDuration } from "@/shared/utils/format";
import { formatSignedRatio } from "@/features/access/access-format";

export const meRouteId = "me.home";
export const hiddenMeText = "민감한 내용은 숨겼습니다.";
const messages: Readonly<Record<string, string>> = {
  me_console_invalid: "개인 데이터의 조회 대상과 응답 형식을 확인하지 못했습니다. 다시 조회하세요.",
  me_console_changed: "계정 또는 작업 상태가 변경됐습니다. 최신 내용을 확인하고 다시 여세요.",
  me_console_unknown: "처리 결과가 불확실합니다. 상태를 확인하기 전에는 같은 작업을 다시 전송할 수 없습니다.",
  me_console_busy: "같은 작업을 처리 중입니다. 완료될 때까지 기다려 주세요.",
  me_console_input: "비밀값과 제어 문자 없이 제한 길이 안에서 입력하세요.",
};
export const meNumber = (value: number | null | undefined, decimals = 0) =>
  value == null ? "—" : formatNumber(value, decimals);
export const meCost = (value: number | null | undefined) => (value == null ? "—" : formatKRW(value));
export const meLatency = (value: number | null | undefined) => (value == null ? "—" : formatDuration(value));
export const meRatio = formatSignedRatio;
export const mePercent = (value: number | null | undefined) =>
  value == null || value < 0 ? "—" : `${formatNumber(value, 1)}%`;
export const meBoolean = (value: boolean | undefined) =>
  value === undefined ? "미확인" : value ? "예" : "아니오";
export const meLabel = (value: string) =>
  (
    ({
      high: "높음",
      medium: "보통",
      low: "낮음",
      critical: "긴급",
      warn: "주의",
      warning: "주의",
      info: "정보",
      expired: "만료",
      expiring_soon: "곧 만료",
      idle: "장기 미사용",
      inactive: "미사용",
      disabled: "중지",
      pending: "승인 대기",
      approved: "승인",
      rejected: "반려",
      block: "차단",
      allow: "허용",
      approval: "승인 필요",
      model_switch: "모델 전환",
      template: "템플릿",
      mcp_tool: "MCP 도구",
      text2sql_report_candidate: "저장 리포트 후보",
      adopted: "적용함",
      dismissed: "필요 없음",
      later: "나중에",
      private: "개인",
      team: "팀",
    }) as Readonly<Record<string, string>>
  )[value] ??
  (value || "—");
export function validMeText(value: string, prefixes: readonly string[], maximum = 500) {
  return (
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !/\p{C}/u.test(value) &&
    !containsPotentialSecret(value, prefixes)
  );
}
export function validMePathID(value: string, prefixes: readonly string[]) {
  // Encoded path parameters still normalize a literal dot segment in fetch URLs.
  return validMeText(value, prefixes, 512) && value !== "." && value !== ".." && !/[\\/]/u.test(value);
}
export function validMeSkillActionName(value: string, prefixes: readonly string[]) {
  // Skill names may contain slashes; withPathParams encodes the whole name.
  // A standalone dot segment is still normalized by fetch before sending.
  return validMeText(value, prefixes, 512) && value !== "." && value !== "..";
}
export function assertMeSkillNames(values: readonly string[], prefixes: readonly string[]) {
  if (new Set(values).size !== values.length || values.some((value) => !validMeText(value, prefixes, 512)))
    throw meError();
}
export function meError(code: "invalid" | "changed" | "unknown" | "busy" | "input" = "invalid") {
  return new AppError(
    messages["me_console_" + code] ?? messages.me_console_invalid ?? "개인 데이터를 확인하세요.",
    { kind: "contract", code: "me_console_" + code },
  );
}
export function safeMeMessage(error: unknown, fallback = "개인 데이터를 불러오지 못했습니다.") {
  const code = isAppError(error) ? error.code : undefined;
  return code && Object.hasOwn(messages, code)
    ? (messages[code] ?? fallback)
    : safeAppErrorMessage(error, fallback);
}
export function safeMeError(error: unknown, prefixes: readonly string[]) {
  return new AppError(safeMeMessage(error), {
    kind: isAppError(error) ? error.kind : "contract",
    status: isAppError(error) ? error.status : undefined,
    code: isAppError(error) && error.code?.startsWith("me_console_") ? error.code : undefined,
    requestId:
      isAppError(error) && error.requestId && validMeText(error.requestId, prefixes, 512)
        ? error.requestId
        : undefined,
  });
}
function mask(value: unknown, prefixes: readonly string[]): unknown {
  if (typeof value === "string") return containsPotentialSecret(value, prefixes) ? hiddenMeText : value;
  if (Array.isArray(value)) return value.map((item: unknown) => mask(item, prefixes));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mask(item, prefixes)]));
  return value;
}
export function projectMe<S extends z.ZodType>(
  schema: S,
  value: unknown,
  prefixes: readonly string[],
): z.output<S> {
  return mask(schema.parse(value), prefixes) as z.output<S>;
}
export function assertMeIDs(values: readonly string[], prefixes: readonly string[]) {
  if (new Set(values).size !== values.length || values.some((value) => !validMePathID(value, prefixes)))
    throw meError();
}
