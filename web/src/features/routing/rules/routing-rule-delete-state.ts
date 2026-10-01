import type { RoutingRule } from "@/shared/api/domains/routing";
import { AppError } from "@/shared/api/error";
import { sameRoutingRule, toggleIdentityReason } from "./routing-toggle-state";

export const deleteConfirmation = "규칙 삭제";
export const deleteSourceChanged =
  "원본 규칙이 변경되었거나 없습니다. 창을 닫고 최신 목록에서 다시 선택하세요.";
export const deleteReviewChanged = "검토한 목록 기준이 바뀌었습니다. 확인 문구를 지우고 다시 입력하세요.";
export const deleteFields = [
  ["id", "원본 규칙 ID"],
  ["enabled", "검토 기준 사용 상태"],
  ["match_pattern", "모델 패턴"],
  ["target_model", "대상 모델"],
  ["target_provider", "대상 공급자"],
  ["min_complexity", "최소 복잡도"],
  ["max_complexity", "최대 복잡도"],
  ["priority", "우선순위"],
  ["note", "메모"],
  ["created_at", "생성 시각 값"],
] as const;

export function deleteIdentityReason(rule: RoutingRule) {
  return toggleIdentityReason(rule.id) ? "원본 규칙 ID를 안전한 삭제 경로로 표현할 수 없습니다." : undefined;
}
export function assertDeleteBaseline(rows: readonly RoutingRule[], baseline: RoutingRule) {
  const matches = rows.filter((row) => row.id === baseline.id);
  if (deleteIdentityReason(baseline) || matches.length !== 1 || !sameRoutingRule(matches[0], baseline))
    throw new AppError(deleteSourceChanged, { kind: "contract", code: "routing_delete_source_changed" });
}
