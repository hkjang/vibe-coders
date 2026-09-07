export const writeScopeMessage = "라우팅 변경 권한(routing:write)이 없어 조회만 할 수 있습니다.";
export const predictScopeMessage = "비용 예측 실행 권한(admin:write)이 없습니다.";

export const routingRulesQueryKey = ["routing", "rules"] as const;
export const routingHealthQueryKey = ["routing", "health"] as const;
export const routingBalancerQueryKey = ["routing", "balancer"] as const;
export const routingDecisionsQueryKey = ["routing", "decisions"] as const;
export const routingLearningQueryKey = ["routing", "learning"] as const;
export const routingDomainQueryKey = ["routing", "domain"] as const;
export const routingPatternsQueryKey = ["routing", "pattern-conflicts"] as const;
export const routingCostGuardQueryKey = ["routing", "cost-guard"] as const;

export function severityTone(severity: string): "danger" | "warning" | "info" {
  if (severity === "critical") return "danger";
  if (severity === "warning") return "warning";
  return "info";
}

export function scoreTone(score: number, threshold: number): "success" | "warning" | "danger" {
  if (score < 40) return "danger";
  if (score < threshold) return "warning";
  return "success";
}
