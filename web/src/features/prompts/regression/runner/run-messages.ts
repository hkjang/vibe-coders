import { isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

const messages: Record<string, string> = {
  golden_run_upgrade: "실행 검토 기능을 제공하는 서버가 필요합니다. 서버 버전을 확인한 뒤 다시 조회하세요.",
  golden_run_model: "모델 식별자에 민감한 값이 포함되어 있습니다. 모델 이름을 확인하세요.",
  golden_run_selection: "실행할 정의를 정확히 선택하세요. 워크플로는 한 번에 하나를 실행합니다.",
  golden_run_hidden:
    "선택한 정의가 없거나 내용 일부를 확인할 수 없어 실행할 수 없습니다. 목록과 원문 조회 권한을 확인하세요.",
  golden_run_limits:
    "예상 호출 수가 지정한 한도를 넘습니다. 선택할 정의·모델을 줄이거나 최대 64회 안에서 한도를 조정하세요.",
  golden_run_changed:
    "검토 후 정의가 변경되었습니다. 최신 내용을 다시 검토하세요. 이번 요청은 모델을 호출하지 않았습니다.",
  golden_run_review: "입력이나 실행 범위가 변경되었습니다. 실행 내용을 다시 검토하고 확인하세요.",
  golden_run_busy: "같은 계정의 회귀 검사가 아직 진행 중입니다. 완료 상태를 확인한 뒤 다시 진행하세요.",
  golden_run_owner: "계정 또는 권한이 변경되어 이 실행의 결과를 표시할 수 없습니다.",
  golden_run_unknown:
    "실행 결과를 확인하지 못했습니다. 일부 모델 호출과 비용이 발생했을 수 있습니다. 자동으로 다시 실행하지 않습니다.",
};
export function runErrorMessage(error: unknown, fallback = "회귀 검사를 준비하지 못했습니다.") {
  return isAppError(error) && error.code && Object.hasOwn(messages, error.code)
    ? (messages[error.code] ?? fallback)
    : safeAppErrorMessage(error, fallback);
}
