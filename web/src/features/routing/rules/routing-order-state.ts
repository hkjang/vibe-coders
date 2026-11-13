import type { OrderSnapshot } from "@/shared/api/domains/routing-order";
import { sameRoutingRule } from "./routing-toggle-state";
import { containsPotentialSecret } from "@/shared/security/secrets";

export const orderText = {
  title: "규칙 순서 변경",
  description: "전체 규칙의 처리 순서를 조정하고 적용 전후를 비교합니다.",
  scope:
    "복잡도 규칙 단계만 비교합니다. 사용자·팀 라우팅, 정책, 학습, 공급자 상태와 대체 경로는 포함하지 않습니다. 모델을 실제 호출하지 않습니다.",
  impact:
    "비활성 규칙을 포함한 전체 우선순위를 1부터 순서대로 저장합니다. 모델·조건·사용 상태는 유지되며, 다른 서버에는 기존 캐시 주기(최대 5초) 후 반영될 수 있습니다.",
  ambiguous:
    "같은 우선순위와 생성 시각을 가진 규칙이 있습니다. 변경 전 동률 순서는 보장되지 않으므로 비교 결과를 유의해 확인하세요.",
  confirm: "전체 우선순위 변경과 비교 범위를 확인했습니다",
  unknown:
    "저장 결과를 확인하지 못했습니다. 이미 반영되었을 수 있어 이 창에서 다시 저장하지 않습니다. 창을 닫고 현재 규칙과 감사 이력을 확인하세요.",
  stale: "설정 또는 검토 조건이 변경되었습니다. 창을 닫고 최신 규칙으로 다시 검토하세요.",
  saved: "라우팅 규칙 순서와 감사 기록을 저장했습니다.",
  moveHelp: "끌어서 놓거나 각 규칙의 위로·아래로 버튼으로 이동하세요. 번호는 저장할 우선순위입니다.",
  unavailable: "두 개 이상의 규칙이 있어야 순서를 변경할 수 있습니다.",
} as const;

export function orderDisplay(value: string, prefixes: readonly string[]): string {
  if (containsPotentialSecret(value, prefixes)) return "민감정보가 포함될 수 있어 표시하지 않습니다.";
  return value.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 300) || "—";
}
export function orderUsable(snapshot: OrderSnapshot, prefixes: readonly string[]): boolean {
  return (
    snapshot.rules.length >= 2 &&
    snapshot.rules.every(
      (rule) =>
        rule.id.length > 0 &&
        [...rule.id].length <= 512 &&
        !/[\p{Cc}\p{Cf}]/u.test(rule.id) &&
        !containsPotentialSecret(rule.id, prefixes),
    )
  );
}
export function moveOrder(ids: readonly string[], from: number, to: number): string[] {
  const next = [...ids];
  if (from < 0 || to < 0 || from >= next.length || to >= next.length) return next;
  const [id] = next.splice(from, 1);
  if (id === undefined) return next;
  next.splice(to, 0, id);
  return next;
}
export function orderAcknowledged(
  before: OrderSnapshot,
  ids: readonly string[],
  after: OrderSnapshot,
): boolean {
  return (
    !after.ambiguous_ties &&
    ids.length === before.rules.length &&
    after.rules.length === ids.length &&
    new Set(ids).size === ids.length &&
    ids.every((id, index) => {
      const original = before.rules.find((rule) => rule.id === id);
      return (
        original !== undefined && sameRoutingRule(after.rules[index], { ...original, priority: index + 1 })
      );
    })
  );
}
