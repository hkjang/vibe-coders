import type { ActionKind } from "@/shared/telemetry/action-channel";
export const actionLabels: Record<ActionKind, string> = {
  save: "저장",
  delete: "삭제",
  approve: "승인",
  reject: "거절",
  revoke: "폐기",
  rotate: "교체",
  rollback: "이전 상태 복원",
  activate: "사용 시작",
  deactivate: "사용 중지",
  import: "가져오기",
  export: "내보내기",
  run_request: "실행 요청 접수",
  test: "검사",
  feedback: "피드백",
};
export function actionSuccessRate(row: { success: number; rejected: number }): string {
  const known = row.success + row.rejected;
  return known === 0
    ? "확인된 결과 없음"
    : `${((row.success / known) * 100).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}%`;
}
