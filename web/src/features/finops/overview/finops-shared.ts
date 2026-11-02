export const finopsBillingQueryKey = ["finops", "billing"] as const;
export const finopsAllocationQueryKey = ["finops", "allocation"] as const;
export const finopsChargebackQueryKey = ["finops", "chargeback"] as const;
export const finopsAnomaliesQueryKey = ["finops", "anomalies"] as const;
export const finopsBudgetAlertsQueryKey = ["finops", "budget-alerts"] as const;

export const costWindows = ["24h", "7d", "30d"] as const;
export const costWindowLabels: Record<string, string> = {
  "24h": "최근 24시간",
  "7d": "최근 7일",
  "30d": "최근 30일",
};
export const defaultCostWindow = "30d";

/** Dimensions `store.CostAllocationDimensions()` accepts. */
export const allocationDimensions = [
  "project",
  "repo",
  "branch",
  "service",
  "cost_center",
  "model",
  "provider",
  "api_key_id",
] as const;
export const defaultAllocationDimension = "project";

export const dimensionLabels: Record<string, string> = {
  project: "프로젝트",
  repo: "저장소",
  branch: "브랜치",
  service: "서비스",
  cost_center: "비용센터",
  model: "모델",
  provider: "공급자",
  api_key_id: "API 키",
  team: "팀",
};

export const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/u;

export function costWindowFrom(value: string | null): string {
  return (costWindows as readonly string[]).includes(value ?? "") ? (value as string) : defaultCostWindow;
}

export function allocationDimensionFrom(value: string | null): string {
  return (allocationDimensions as readonly string[]).includes(value ?? "")
    ? (value as string)
    : defaultAllocationDimension;
}

export function currentMonth(now = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
  }).format(now);
}

export function severityTone(severity: string): "danger" | "warning" | "success" | "info" {
  if (severity === "critical") return "danger";
  if (severity === "warn" || severity === "warning") return "warning";
  if (severity === "ok") return "success";
  return "info";
}

export function budgetSeverityLabel(severity: string): string {
  if (severity === "critical") return "위험";
  if (severity === "warn" || severity === "warning") return "경고";
  if (severity === "ok") return "정상";
  return "상태 미확인";
}
