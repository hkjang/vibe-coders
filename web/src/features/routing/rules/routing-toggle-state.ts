import type { RoutingRule } from "@/shared/api/domains/routing";
import { AppError } from "@/shared/api/error";

export const toggleListReason = "최신 규칙 목록을 정상 조회한 뒤 변경 대상을 다시 확인하세요.";
export function toggleIdentityReason(id: string): string | undefined {
  return id === "" || id === "." || id === ".." || id.includes("/")
    ? "이 원본 규칙 ID는 상태 변경 경로로 안전하게 표현할 수 없습니다. 상태 변경을 차단합니다."
    : undefined;
}
export function sameRoutingRule(a: RoutingRule | undefined, b: RoutingRule): boolean {
  return (
    !!a &&
    a.id === b.id &&
    a.enabled === b.enabled &&
    a.priority === b.priority &&
    a.match_pattern === b.match_pattern &&
    a.min_complexity === b.min_complexity &&
    a.max_complexity === b.max_complexity &&
    a.target_model === b.target_model &&
    a.target_provider === b.target_provider &&
    a.note === b.note &&
    a.created_at === b.created_at
  );
}
export function assertToggleBaseline(rows: readonly RoutingRule[], baseline: RoutingRule, intended: boolean) {
  const identity = toggleIdentityReason(baseline.id);
  if (identity) throw new AppError(identity, { kind: "contract" });
  const current = rows.find((rule) => rule.id === baseline.id);
  if (!sameRoutingRule(current, baseline) || current?.enabled === intended)
    throw new AppError("규칙 상태나 설정이 변경되었습니다. 최신 목록과 원래 변경 의도를 다시 확인하세요.", {
      kind: "contract",
    });
}
