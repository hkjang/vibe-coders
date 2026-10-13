import { isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

// Personal-key messages belong to this route, not every operational screen.
const messages = {
  invalid_key_rotation: "키 정보와 변경 사유, 유예 기간을 다시 확인하세요.",
  key_rotation_conflict: "키 정보가 바뀌었거나 이미 회전·폐기·만료되었습니다. 최신 목록에서 다시 확인하세요.",
  key_rotation_authority_unavailable: "현재 팀 권한을 확인할 수 없어 키를 회전하지 않았습니다.",
  key_rotate_failed: "회전 결과를 확인할 수 없습니다. 다시 요청하지 말고 키 목록과 감사 이력을 확인하세요.",
  key_scopes_conflict: "키 정보가 변경되었습니다. 최신 목록에서 권한을 다시 검토하세요.",
  key_update_failed: "키 권한 변경 결과를 확인할 수 없습니다. 최신 목록을 확인하세요.",
} as const;

export function meKeyErrorMessage(error: unknown, fallback: string): string {
  const code = isAppError(error) ? error.code?.trim() : undefined;
  return code && Object.hasOwn(messages, code)
    ? messages[code as keyof typeof messages]
    : safeAppErrorMessage(error, fallback);
}
