import { isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

export function keyEditError(error: unknown, fallback: string): string {
  if (!isAppError(error)) return fallback;
  if (error.kind === "aborted" && error.code === "key_edit_review_required")
    return "최신 키 정보, 변경 사유와 변경 내용 확인을 다시 검토하세요.";
  if (error.kind === "http") {
    if (error.status === 409 && error.code === "key_update_conflict")
      return "키 정보가 변경되어 저장하지 않았습니다. 창을 닫고 최신 목록에서 다시 검토하세요.";
    if (error.status === 400 && error.code === "invalid_key_update")
      return "변경 항목과 사유를 확인할 수 없어 저장하지 않았습니다. 창을 닫고 다시 검토하세요.";
    if (error.status === 503 && error.code === "key_update_authority_unavailable")
      return "서버가 검토 정보를 확인할 수 없어 저장하지 않았습니다. 서버 상태와 최신 목록을 확인하세요.";
  }
  if (["network", "timeout"].includes(error.kind) || (error.kind === "http" && (error.status ?? 0) >= 500))
    return "저장 결과를 확인할 수 없습니다. 재전송하지 말고 목록과 감사 이력에서 적용 여부를 확인하세요.";
  return safeAppErrorMessage(error, fallback);
}
