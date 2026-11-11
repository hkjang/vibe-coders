import type { z } from "zod";
import { AppError, isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { formatDuration, formatKRW, formatNumber } from "@/shared/utils/format";
import { formatSignedRatio } from "@/features/access/access-format";

export const teamRouteId = "team.home";
const messages: Readonly<Record<string, string>> = {
  team_console_changed:
    "리포트 또는 작업 권한이 변경됐습니다. 최신 내용을 조회하고 검토창을 다시 열어 주세요.",
  team_console_unknown: "처리 결과를 확인하지 못했습니다. 목록과 감사 이력을 확인한 뒤 페이지를 다시 여세요.",
  team_console_busy: "진행 중인 팀 리포트 작업이 있습니다. 완료 후 다시 확인하세요.",
  team_console_invalid:
    "팀·리포트 응답 또는 입력을 확인하세요. 사유는 비밀값 없이 500자 이내로 입력해야 합니다.",
  team_console_unavailable: "팀 정보를 확인하지 못했습니다. 다시 조회하세요.",
};
export function safeTeamMessage(error: unknown, fallback: string) {
  const code = isAppError(error) ? error.code : undefined;
  return code && Object.hasOwn(messages, code)
    ? (messages[code] ?? fallback)
    : safeAppErrorMessage(error, fallback);
}
export const hiddenTeamText = "민감한 내용은 숨겼습니다.";
export const teamWindows = ["7d", "30d", "90d"] as const;
export type TeamWindow = (typeof teamWindows)[number];
export const teamWindowLabel = (value: TeamWindow) =>
  ({ "7d": "최근 7일", "30d": "최근 30일", "90d": "최근 90일" })[value];
export const teamNumber = (value: number | null | undefined) => (value == null ? "—" : formatNumber(value));
export const teamCost = (value: number | null | undefined) => (value == null ? "—" : formatKRW(value));
export const teamLatency = (value: number | null | undefined) =>
  value == null ? "—" : formatDuration(value);
export const teamPercent = formatSignedRatio;
export function validTeamText(value: string, prefixes: readonly string[], maximum = 120) {
  return (
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !Array.from(value).some((char) => /\p{C}/u.test(char)) &&
    !containsPotentialSecret(value, prefixes)
  );
}
export function teamError(code: "changed" | "unknown" | "busy" | "invalid" | "unavailable" = "invalid") {
  return new AppError("팀 작업의 조회 범위와 상태를 확인하세요.", {
    kind: "contract",
    code: "team_console_" + code,
  });
}
export function safeTeamError(error: unknown, prefixes: readonly string[]) {
  return new AppError(safeTeamMessage(error, "팀 데이터를 확인하지 못했습니다."), {
    kind: isAppError(error) ? error.kind : "network",
    status: isAppError(error) ? error.status : undefined,
    code: isAppError(error) && error.code?.startsWith("team_console_") ? error.code : undefined,
    requestId:
      isAppError(error) && error.requestId && validTeamText(error.requestId, prefixes, 512)
        ? error.requestId
        : undefined,
  });
}
function mask(value: unknown, prefixes: readonly string[]): unknown {
  if (typeof value === "string") return containsPotentialSecret(value, prefixes) ? hiddenTeamText : value;
  if (Array.isArray(value)) return value.map((item: unknown) => mask(item, prefixes));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mask(item, prefixes)]));
  return value;
}
export function projectTeam<S extends z.ZodType<{ team_id: string }>>(
  schema: S,
  value: unknown,
  expectedTeam: string,
  prefixes: readonly string[],
): z.output<S> {
  const parsed = schema.parse(value);
  if (parsed.team_id !== expectedTeam || !validTeamText(parsed.team_id, prefixes)) throw teamError();
  return mask(parsed, prefixes) as z.output<S>;
}
export function assertTeamIDs(rows: readonly { id: string }[], prefixes: readonly string[]) {
  if (
    new Set(rows.map((row) => row.id)).size !== rows.length ||
    rows.some((row) => !validTeamText(row.id, prefixes, 512))
  )
    throw teamError();
}
