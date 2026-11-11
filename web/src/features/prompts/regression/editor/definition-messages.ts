import { AppError, isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

const messages = {
  golden_changed: "다른 변경이 있거나 항목을 찾지 못했습니다. 초안을 확인하고 목록에서 편집창을 다시 여세요.",
  golden_review: "현재 변경 내용과 적용 범위를 다시 확인하세요.",
  golden_busy: "회귀 검증 정의를 저장 중입니다. 완료 후 다시 확인하세요.",
  golden_unknown: "저장 응답을 확인하지 못했습니다. 재전송하지 않고 현재 저장 상태를 조회하세요.",
  golden_unmatched: "현재 저장된 정의가 전송한 내용과 일치하지 않습니다. 목록과 감사 이력을 확인하세요.",
  golden_owner: "현재 계정과 변경 권한이 달라졌습니다. 다시 확인하세요.",
} as const;
export type DefinitionErrorCode = keyof typeof messages;
export function definitionError(code: DefinitionErrorCode) {
  return new AppError(messages[code], { kind: "permission", code });
}
export function definitionErrorMessage(error: unknown, fallback: string) {
  return isAppError(error) && error.code && Object.hasOwn(messages, error.code)
    ? messages[error.code as DefinitionErrorCode]
    : safeAppErrorMessage(error, fallback);
}
